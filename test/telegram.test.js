import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, TelegramRequestError, UncertainDeliveryError, formatPost } from '../src/telegram.js';

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
      assert.equal(init.body.includes(movie.url), false);
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
  assert.equal(post.reply_markup.inline_keyboard.length, 1);
  assert.equal(JSON.stringify(post).includes(movie.url), false);
  assert.equal(post.caption.includes('source page'), false);
  const withImdb = formatPost({ ...movie, imdbId: 'tt1234567', links: Array.from({ length: 25 }, (_, i) => ({ label: 'Download ' + i, url: 'https://files.example/' + i })) });
  assert.equal(JSON.stringify(withImdb).includes(movie.url), false);
  assert.equal(withImdb.caption.includes('source page'), false);
  assert.equal(withImdb.reply_markup.inline_keyboard.length, 12);
  assert.equal(JSON.stringify(withImdb).includes('imdb.com'), false);
  assert.match(withImdb.caption, /Audio: Hindi, English\nIMDb : 7\.3\/10/);
});

test('missing, zero and invalid ratings render as Not available, including saved queue values', () => {
  for (const rating of [undefined, null, '', ' ', 'N/A', 0, '0', '0.0', -1, 'invalid', 11]) {
    const post = formatPost({ ...movie, rating });
    assert.match(post.caption, /IMDb : Not available(?:\n|$)/);
    assert.equal(post.caption.includes('IMDb : 0/10'), false);
  }
  assert.match(formatPost({ ...movie, rating: '8' }).caption, /IMDb : 8\/10/);
});

test('group rename uses the movie title and suffix without topic or message fields', async () => {
  const client = new TelegramClient({ token: 'test', chatId: '-100123', threadId: '7' }, {
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/setChatTitle'));
      assert.deepEqual(JSON.parse(init.body), { chat_id: '-100123', title: 'Example & Journey Latest Movie' });
      return response(200, { ok: true, result: true });
    }
  });
  await client.renameGroup(movie.title);
});

test('long Unicode group titles retain suffix and fit the limit', async () => {
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async (url, init) => {
      const { title } = JSON.parse(init.body);
      assert.ok(title.length <= 128);
      assert.ok(title.endsWith(' Latest Movie'));
      assert.equal(title.includes('\uFFFD'), false);
      assert.equal(/[\uD800-\uDBFF] Latest Movie$/.test(title), false);
      return response(200, { ok: true, result: true });
    }
  });
  await client.renameGroup('🎬'.repeat(100));
});

test('an already matching group title is accepted and private chats are skipped', async () => {
  let calls = 0;
  const client = new TelegramClient({ token: 'test', chatId: '123' }, {
    fetchImpl: async () => {
      calls++;
      return response(400, { ok: false, error_code: 400, description: 'Bad Request: chat title is not modified' });
    }
  });
  await client.renameGroup(movie.title);
  client.chatType = 'private';
  await client.renameGroup(movie.title);
  assert.equal(calls, 1);
});


test('upgraded group retries with the supergroup ID and uses it for later calls', async () => {
  const calls = [];
  const client = new TelegramClient({ token: 'test', chatId: '-123' }, {
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split('/').at(-1), body: JSON.parse(init.body) });
      if (calls.length === 1) return response(400, { ok: false, error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -100123 } });
      return response(200, { ok: true, result: { message_id: 10 } });
    }
  });
  assert.equal((await client.send(movie)).message_id, 10);
  await client.renameGroup(movie.title);
  assert.deepEqual(calls.map(call => call.body.chat_id), ['-123', '-100123', '-100123']);
  assert.deepEqual(calls.map(call => call.method), ['sendPhoto', 'sendPhoto', 'setChatTitle']);
});

test('Telegram error identifies the method and reason without exposing the token', async () => {
  const client = new TelegramClient({ token: 'secret-token', chatId: '-123' }, {
    fetchImpl: async () => response(400, { ok: false, error_code: 400, description: 'Bad Request: secret-token invalid chat' })
  });
  await assert.rejects(client.verify(), error => {
    assert.match(error.message, /getMe.*400.*invalid chat/);
    assert.equal(error.message.includes('secret-token'), false);
    return true;
  });
});


for (const failure of ['network', 'server']) {
  test('approval polling retries transient ' + failure + ' failures with the same offset', async () => {
    let calls = 0;
    const waits = [];
    const client = new TelegramClient({ token: 'test', chatId: '123' }, {
      fetchImpl: async (url, init) => {
        assert.ok(url.endsWith('/getUpdates'));
        assert.deepEqual(JSON.parse(init.body), { offset: 123, timeout: 20 });
        if (++calls === 1) {
          if (failure === 'network') throw new Error('Connection reset');
          return response(502, { ok: false });
        }
        return response(200, { ok: true, result: [{ update_id: 123 }] });
      },
      sleepImpl: async ms => waits.push(ms)
    });
    assert.deepEqual(await client.call('getUpdates', { offset: 123, timeout: 20 }), [{ update_id: 123 }]);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1500]);
  });
}

test('exhausted polling retries identify getUpdates without claiming a group delivery happened', async () => {
  let calls = 0;
  const client = new TelegramClient({ token: 'secret-token', chatId: '123' }, {
    fetchImpl: async () => { calls++; throw new Error('Network failed: secret-token'); },
    sleepImpl: async () => {}
  });
  await assert.rejects(client.call('getUpdates'), error => {
    assert.ok(error instanceof TelegramRequestError);
    assert.match(error.message, /getUpdates.*Pending approvals are preserved/);
    assert.equal(error.message.includes('secret-token'), false);
    assert.equal(error.message.includes('resolve the pending delivery'), false);
    return true;
  });
  assert.equal(calls, 4);
});
