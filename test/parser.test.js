import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, parseMovie, cleanTitle, movieKeys, publicUrl, exclusion } from '../src/parser.js';
const listing = await readFile(new URL('fixtures/listing.html', import.meta.url), 'utf8');
const detail = await readFile(new URL('fixtures/detail.html', import.meta.url), 'utf8');
const base = 'https://movies.example/';

test('listing discovers movie cards and same-origin pagination, ignoring navigation', () => {
  const parsed = parseListing(listing, base);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].poster, base + 'poster.jpg');
  assert.equal(parsed.nextUrl, base + 'page/2/');
  assert.throws(() => parseListing('<h1>Access denied</h1>', base), /No movie cards/);
});
test('details extract title, actual audio languages, rating, poster and unique download buttons', () => {
  const movie = parseMovie(detail, base + 'journey-2024/');
  assert.equal(movie.title, 'The Journey');
  assert.equal(movie.year, '2024');
  assert.equal(movie.rating, '7.3');
  assert.deepEqual(movie.languages, ['Hindi', 'English']);
  assert.equal(movie.links.length, 2);
  assert.equal(movie.imdbId, 'tt1234567');
  assert.equal(movie.poster, base + 'poster.jpg');
});
test('language filtering does not use Hindi mentions from boilerplate', () => {
  const html = detail.replace('Hindi English', 'Marathi').replace('Languages: Hindi English', 'Languages: Marathi') + '<footer>Hindi and English movies</footer>';
  assert.equal(parseMovie(html, base).excluded, 'no Hindi or English audio');
});
test('episodic shows and adult videos do not enter movie notifications', () => {
  assert.equal(exclusion('Example (2024) English Adult Video'), 'adult video');
  assert.equal(exclusion('Example S01E[01-10] Hindi Series'), 'episodic show');
  assert.equal(exclusion('Example (2024) Hindi UNRATED Crime Movie'), null);
});
test('movie identity ignores release quality and title punctuation', () => {
  assert.deepEqual(cleanTitle('Download The Journey (2024) Hindi 1080p'), { title: 'The Journey', year: '2024' });
  assert.deepEqual(cleanTitle('The Journey Movie Download Hindi Full Movie Watch 1080p'), { title: 'The Journey', year: null });
  assert.equal(movieKeys({ title: 'The-Journey', year: '2024' })[0], movieKeys({ title: 'The Journey', year: '2024' })[0]);
});
test('unsafe or absent URLs are rejected', () => {
  for (const input of [undefined, '', 'javascript:alert(1)', 'https://user:pass@example.com/']) assert.equal(publicUrl(input, base), null);
});
test('missing buttons remain retryable instead of producing incomplete notifications', () => {
  const html = '<h1 class="entry-title">Example (2024) Hindi</h1><div class="entry-content"><p>Languages: Hindi</p></div>';
  assert.throws(() => parseMovie(html, base), /No download buttons/);
});

test('missing and zero source ratings stay unavailable instead of using the denominator as a score', () => {
  for (const value of ['0/10', '0.0/10', 'N/A', 'N/A /10', '']) {
    const html = detail.replace('7.3/10', value);
    assert.equal(parseMovie(html, base + 'journey-2024/').rating, null);
  }
  assert.equal(parseMovie(detail.replace('7.3/10', '10/10'), base).rating, '10');
});


test('pagination to an unrelated origin is still rejected', () => {
  const html = listing.replace('href="/page/2/"', 'href="https://unrelated.example/page/2/"');
  assert.throws(() => parseListing(html, base), /Unexpected cross-site pagination/);
});
