import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, UncertainDeliveryError, formatPost } from '../src/telegram.js';

const movie = {
  title: 'Example & Journey', year: '2024', languages: ['Hindi', 'English'], rating: '7.3',
  ratingSource: 'website (unverified)', poster: 'https://example.com/poster.jpg',
  url: 'https://example.com/movie/', links: [{ label: '1080p', url: 'https://example.com/file' }]
};
const response = (status, body) => ({ status, json: async () => body });
test('Telegram flood limit retries after the requested delay', async () => {
  let calls = 0, waited = 0;
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async () => ++calls === 1
      ? response(429, { ok: false, error_code: 429, parameters: { retry_after: 5 } })
      : response(200, { ok: true, result: { message_id: 9 } }),
    sleepImpl: async ms => { waited = ms; }
  });
  assert.equal((await client.send(movie)).message_id, 9);
  assert.equal(calls, 2);
  assert.ok(waited >= 5000);
});
test('photo rejection falls back to text, preserving all buttons', async () => {
  const methods = [];
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async (url, init) => {
      methods.push(url.split('/').at(-1));
      if (methods.length === 1) return response(400, { ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content' });
      const body = JSON.parse(init.body);
      assert.equal(body.reply_markup.inline_keyboard[0][0].url, movie.links[0].url);
      return response(200, { ok: true, result: { message_id: 3 } });
    }
  });
  await client.send(movie);
  assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
});
test('network uncertainty never retries a send or falls back to another message', async () => {
  let calls = 0;
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async () => { calls++; throw new Error('Network failed'); }
  });
  await assert.rejects(client.send(movie), UncertainDeliveryError);
  assert.equal(calls, 1);
});
test('server errors are treated as uncertain delivery', async () => {
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async () => response(502, { ok: false })
  });
  await assert.rejects(client.send(movie), UncertainDeliveryError);
});
test('captions escape titles and keep link options as buttons', () => {
  const post = formatPost(movie);
  assert.match(post.caption, /Example &amp; Journey/);
  assert.ok(post.caption.length < 1024);
  assert.equal(post.reply_markup.inline_keyboard.length, 2);
});
