import { getText } from './http.js';
import { normalizeRating } from './rating.js';

const normalized = title => title.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export class MetadataClient {
  constructor(key, budget, { get = getText, log = console.log } = {}) {
    this.key = key;
    this.budget = budget;
    this.get = get;
    this.log = log;
    this.cache = new Map();
  }
  async enrich(movie) {
    if (normalizeRating(movie.rating) && movie.imdbId && movie.poster) return movie;
    if (!this.key || this.budget <= 0) return movie;
    const cacheKey = movie.imdbId || movie.title + ':' + movie.year;
    let data = this.cache.get(cacheKey);
    if (!data) {
      this.budget--;
      const url = new URL('https://www.omdbapi.com/');
      url.searchParams.set('apikey', this.key);
      url.searchParams.set('type', 'movie');
      if (movie.imdbId) url.searchParams.set('i', movie.imdbId);
      else {
        url.searchParams.set('t', movie.title);
        if (movie.year) url.searchParams.set('y', movie.year);
      }
      try {
        // One attempt keeps the configured external API request budget exact.
        data = JSON.parse(await this.get(url.href, { attempts: 1 }));
      } catch {
        this.log('External rating lookup unavailable; retaining website metadata.');
        return movie;
      }
      this.cache.set(cacheKey, data);
    }
    if (data.Response !== 'True' || data.Type !== 'movie') {
      if (/limit|key|quota/i.test(data.Error || '')) {
        this.budget = 0;
        this.log('External rating API quota/key unavailable for this run.');
      }
      return movie;
    }
    if (!movie.imdbId && (normalized(data.Title || '') !== normalized(movie.title) ||
        (movie.year && String(data.Year) !== String(movie.year)))) return movie;
    const rating = normalizeRating(data.imdbRating);
    const fallbackRating = normalizeRating(movie.rating);
    return {
      ...movie,
      imdbId: /^tt\d+$/.test(data.imdbID || '') ? data.imdbID : movie.imdbId,
      poster: movie.poster || (data.Poster?.startsWith('https://') ? data.Poster : null),
      rating: rating || fallbackRating,
      ratingSource: rating ? 'OMDb / IMDb' : (fallbackRating ? movie.ratingSource : null)
    };
  }
}
