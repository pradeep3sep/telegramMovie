import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyState } from '../src/state.js';
import { runCycle } from '../src/runner.js';
import { TelegramError, UncertainDeliveryError } from '../src/telegram.js';
const listing = (await readFile(new URL('fixtures/listing.html', import.meta.url), 'utf8'))
  .replace(/<a class="nextpostslink"[^>]*>Next<\/a>/, '');
const detail = await readFile(new URL('fixtures/detail.html', import.meta.url), 'utf8');
const source = { url: 'https://movies.example/', name: 'Example', adapter: 'wordpress' };
const config = {
  sources: [source], runtimeMs: 600000, catalogPages: 1, recentPages: 2,
  maxMessages: 10, requestDelay: 0, telegramDelay: 0
};
function dependencies(extra = {}) {
  return {
    get: async url => url === source.url ? listing : detail,
    sleepImpl: async () => {}, log: () => {}, save: async () => {}, ...extra
  };
}
test('second cycle does not repost a previously sent movie', async () => {
  const state = emptyState();
  let sends = 0;
  const deps = dependencies({ telegram: { send: async () => ({ message_id: ++sends }) } });
  await runCycle(config, state, deps);
  await runCycle(config, state, deps);
  assert.equal(sends, 1);
  assert.equal(state.pendingDelivery, null);
  assert.equal(Object.values(state.items).filter(item => item.status === 'sent').length, 1);
});
test('initial catalog pagination resumes across runs', async () => {
  const state = emptyState();
  const page1 = listing.replace('</body>', '<a rel="next" href="/page/2/">Next</a></body>');
  const page2 = listing.replaceAll('/journey-2024/', '/journey-copy/');
  const deps = dependencies({
    get: async url => url === source.url ? page1 : url.includes('/page/') ? page2 : detail,
    telegram: { send: async () => ({ message_id: 11 }) }
  });
  await runCycle(config, state, deps);
  assert.equal(state.sources[source.url].backfillUrl, source.url + 'page/2/');
  assert.equal(state.sources[source.url].backfillDone, false);
  await runCycle(config, state, deps);
  assert.equal(state.sources[source.url].backfillDone, true);
  assert.equal(Object.values(state.items).filter(item => item.status === 'duplicate').length, 1);
});
test('uncertain delivery pauses future runs rather than resending', async () => {
  const state = emptyState();
  const snapshots = [];
  await assert.rejects(runCycle(config, state, dependencies({
    save: async s => snapshots.push(structuredClone(s)),
    telegram: { send: async () => { throw new UncertainDeliveryError(); } }
  })), /could not be confirmed/);
  assert.ok(state.pendingDelivery);
  assert.ok(snapshots.some(s => s.pendingDelivery));
  await assert.rejects(runCycle(config, state, dependencies()), /needs confirmation/);
});
test('explicit Telegram rejection clears intent and preserves the queue', async () => {
  const state = emptyState();
  await assert.rejects(runCycle(config, state, dependencies({
    telegram: { send: async () => { throw new TelegramError(403, 'Forbidden'); } }
  })), /rejected/);
  assert.equal(state.pendingDelivery, null);
  assert.equal(Object.values(state.items).filter(item => item.status === 'queued').length, 1);
});
test('preview never calls Telegram or marks a movie sent', async () => {
  const state = emptyState();
  let sends = 0;
  const result = await runCycle(config, state, dependencies({
    dryRun: true, telegram: { send: async () => { sends++; } }
  }));
  assert.equal(result.preview.length, 1);
  assert.equal(sends, 0);
  assert.equal(Object.keys(state.movies).length, 0);
});
test('scraper failure is visible and does not finish the initial catalog', async () => {
  const state = emptyState();
  await assert.rejects(runCycle(config, state, dependencies({ get: async () => '<h1>Blocked</h1>' })), /failed scan/);
  assert.equal(state.sources[source.url].backfillDone, false);
});
