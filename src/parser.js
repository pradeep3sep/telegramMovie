import { load } from 'cheerio';
import { normalizeRating } from './rating.js';
import { createHash } from 'node:crypto';

export const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

export function publicUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function itemId(url) {
  const normalized = new URL(url);
  normalized.hash = '';
  normalized.search = '';
  normalized.pathname = normalized.pathname.replace(/\/+$/, '') || '/';
  return createHash('sha256').update(normalized.href).digest('hex');
}

export function exclusion(title) {
  // This is a movie notifier; adult videos and episodic shows are excluded.
  if (/\b(?:onlyfans|brazzers|porn|xxx|adult\s+(?:video|movie|film)|hot\s+short\s+film|app\s+con[n]?tent|unrated\s+.*short\s+film)\b|\[18\+\]/i.test(title)) return 'adult video';
  if (/\b(?:web[\s-]?series|series|season\s*\d+|s\d{1,2}\s*e\s*[\d[]|episodes?|full\s+show|bonus\s+show)\b/i.test(title)) return 'episodic show';
  return null;
}

export function languages(value) {
  const text = String(value || '');
  const found = [];
  if (/\bhindi\b|हिन्दी|हिंदी/i.test(text)) found.push('Hindi');
  if (/\benglish\b/i.test(text)) found.push('English');
  return found;
}

export function parseListing(html, pageUrl) {
  const $ = load(html);
  const entries = [];
  const seen = new Set();
  $('article .entry-title a, article .post-title a, .post-item .entry-title a').each((_, element) => {
    const link = $(element);
    const url = publicUrl(link.attr('href'), pageUrl);
    const title = compact(link.text() || link.attr('title'));
    if (!url || !title || seen.has(url) || new URL(url).origin !== new URL(pageUrl).origin) return;
    seen.add(url);
    const image = link.closest('article, .post-item').find('img').first();
    entries.push({
      id: itemId(url), url, title,
      poster: publicUrl(image.attr('data-src') || image.attr('src'), pageUrl)
    });
  });
  const next = $('a[rel="next"], .nextpostslink, a.next.page-numbers').first().attr('href');
  const nextUrl = next ? publicUrl(next, pageUrl) : null;
  if (nextUrl && new URL(nextUrl).origin !== new URL(pageUrl).origin) throw new Error('Unexpected cross-site pagination.');
  // Never treat an access-denied page or changed markup as the end of the catalog.
  if (!entries.length) throw new Error('No movie cards found; source layout may have changed or access may be blocked.');
  return { entries, nextUrl };
}

export function cleanTitle(rawTitle) {
  const value = compact(rawTitle).replace(/^download\s+/i, '');
  const yearMatch = value.match(/\((19\d{2}|20\d{2})\)/);
  const year = yearMatch?.[1] || null;
  let title = yearMatch ? value.slice(0, yearMatch.index) : value;
  if (!yearMatch) {
    title = title.split(/\b(?:Hindi|English|Dual Audio|ORG|BluRay|HDRip|WEB-DL|480p|720p|1080p|2160p)\b/i)[0];
  }
  title = compact(title.replace(/\s*[-|–]*\s*Vegamovies\s*$/i, '')).replace(/[-|–:\s]+$/, '');
  title = title.replace(/\s+(?:movie\s+)?download$/i, '').trim();
  return { title, year };
}

function metadataLine($, content, labelPattern) {
  const clone = content.clone();
  clone.find('br').replaceWith('\n');
  clone.find('script, style').remove();
  const text = clone.text();
  const match = text.match(new RegExp('(?:^|\\n)\\s*(?:' + labelPattern + ')\\s*:\\s*([^\\n]+)', 'im'));
  return match ? compact(match[1]) : '';
}

export function parseMovie(html, pageUrl, listing = {}) {
  const $ = load(html);
  const content = $('.entry-content').first();
  if (!content.length) throw new Error('Movie content not found; source layout may have changed.');
  const rawTitle = compact($('h1.entry-title').first().text() || listing.title || content.find('h1, h2').first().text());
  const reason = exclusion(rawTitle);
  if (reason) return { excluded: reason };
  const languageLine = metadataLine($, content, 'Languages?|Audio');
  // Ignore SEO boilerplate elsewhere on the page mentioning Hindi/English.
  const availableLanguages = languages(languageLine || rawTitle);
  if (!availableLanguages.length) return { excluded: 'no Hindi or English audio' };
  const named = cleanTitle(metadataLine($, content, 'Title|Movie Name') || rawTitle);
  if (!named.title) throw new Error('Movie title is missing.');
  const ratingLine = metadataLine($, content, 'IMDB\\s*Ratings?|IMDb');
  const ratingMatch = ratingLine.match(/^\s*(10(?:\.0+)?|[0-9](?:\.\d+)?)\s*(?:\/\s*10)?(?:\s|$)/);
  const rating = normalizeRating(ratingMatch?.[1]);
  const imdbUrl = content.find('a[href*="imdb.com/title/"]').first().attr('href') || '';
  const imdbId = imdbUrl.match(/\btt\d{5,12}\b/)?.[0] || null;
  const firstImage = content.find('img').first();
  const poster = publicUrl($('meta[property="og:image"]').attr('content') || firstImage.attr('data-src') || firstImage.attr('src') || listing.poster, pageUrl);
  const links = [];
  const unique = new Set();
  content.find('a[href]').each((_, element) => {
    const anchor = $(element);
    const label = compact(anchor.text());
    const url = publicUrl(anchor.attr('href'), pageUrl);
    if (!url || !label || unique.has(url)) return;
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)(?:t\.me|telegram\.me|imdb\.com|facebook\.com|instagram\.com|youtube\.com|twitter\.com|x\.com)$/.test(host)) return;
    // Read only download buttons actually in the movie content, never ads or popups.
    const isButton = /\b(?:480p|720p|1080p|2160p|4k|download|g-?direct|drive\s+link|mega\s+link)\b/i.test(label);
    if (!isButton || /join|telegram|trailer|sample|screenshot/i.test(label)) return;
    if (new URL(url).origin === new URL(pageUrl).origin && /\/(?:category|tag|page)\//.test(new URL(url).pathname)) return;
    const linkLanguages = languages(label);
    if (!linkLanguages.length && /\b(?:Tamil|Telugu|Malayalam|Kannada|Bengali|Marathi)\b/i.test(label)) return;
    unique.add(url);
    links.push({ label: label.slice(0, 64), url });
  });
  if (!links.length) throw new Error('No download buttons found; leave this movie queued for a future run.');
  return {
    ...named, rawTitle, url: pageUrl, languages: availableLanguages, poster, links, imdbId,
    rating, ratingSource: rating ? 'website (unverified)' : null
  };
}

export function movieKeys(movie) {
  const normalized = movie.title.normalize('NFKD').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const keys = ['title:' + normalized + ':' + (movie.year || 'unknown')];
  if (movie.imdbId) keys.push('imdb:' + movie.imdbId);
  return keys;
}
