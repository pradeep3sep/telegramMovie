import test from 'node:test';
import assert from 'node:assert/strict';
import { getPage, getText } from '../src/http.js';

test('HTML fetch preserves the final response URL after a domain redirect', async () => {
  const page = await getPage('https://old.example/', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://old.example/');
      assert.equal(options.redirect, 'follow');
      return { ok: true, url: 'https://new.example/', text: async () => '<html>Movie</html>' };
    }
  });
  assert.deepEqual(page, { html: '<html>Movie</html>', url: 'https://new.example/' });
});

test('text fetch retains its string contract for metadata callers', async () => {
  const value = await getText('https://metadata.example/', {
    fetchImpl: async () => ({ ok: true, url: 'https://metadata.example/', text: async () => '{"Title":"Movie"}' })
  });
  assert.equal(value, '{"Title":"Movie"}');
});
