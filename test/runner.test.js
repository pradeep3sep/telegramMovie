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
    sleepImpl: async () => {}, log: () => {}, save: async () => {}, ...extra,
    ...(extra.telegram ? { telegram: { renameGroup: async () => {}, ...extra.telegram } } : {})
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

test('renames after a confirmed saved post and never again for duplicates', async () => {
  const state = emptyState(), events = [];
  const deps = dependencies({
    telegram: {
      send: async () => { events.push('send'); return { message_id: 7 }; },
      renameGroup: async title => {
        assert.equal(state.pendingDelivery, null);
        assert.equal(Object.values(state.items).filter(item => item.status === 'sent').length, 1);
        events.push(title);
      }
    },
    save: async s => { if (s.pendingGroupTitle) events.push('saved'); }
  });
  await runCycle(config, state, deps);
  await runCycle(config, state, deps);
  assert.deepEqual(events, ['send', 'saved', 'The Journey']);
  assert.equal(state.pendingGroupTitle, undefined);
});

test('failed rename is persisted and retried without reposting', async () => {
  const state = emptyState();
  let sends = 0, renames = 0;
  const deps = dependencies({
    telegram: {
      send: async () => ({ message_id: ++sends }),
      renameGroup: async () => {
        if (++renames === 1) throw new TelegramError(403, 'Forbidden');
      }
    }
  });
  await runCycle(config, state, deps);
  assert.equal(state.pendingGroupTitle, 'The Journey');
  assert.equal(state.pendingDelivery, null);
  await runCycle(config, state, deps);
  assert.equal(sends, 1);
  assert.equal(renames, 2);
  assert.equal(state.pendingGroupTitle, undefined);
});

test('preview preserves pending rename without calling Telegram', async () => {
  const state = emptyState();
  state.pendingGroupTitle = 'Previous Movie';
  await runCycle(config, state, dependencies({
    dryRun: true,
    telegram: {
      send: async () => assert.fail('preview sent a message'),
      renameGroup: async () => assert.fail('preview renamed the group')
    }
  }));
  assert.equal(state.pendingGroupTitle, 'Previous Movie');
});


test('local test sends one movie on each invocation without saving normal history', async () => {
  const { runTestCycle } = await import('../src/local-cycle.js');
  let sends = 0;
  const deps = dependencies({
    save: async () => {},
    telegram: { send: async () => ({ message_id: ++sends }) }
  });
  assert.equal((await runTestCycle(config, deps)).summary.sent, 1);
  assert.equal((await runTestCycle(config, deps)).summary.sent, 1);
  assert.equal(sends, 2);
});

test('local test fails visibly when no eligible movie can be sent', async () => {
  const { runTestCycle } = await import('../src/local-cycle.js');
  await assert.rejects(runTestCycle({ ...config, sources: [] }, dependencies({
    telegram: { send: async () => { throw new Error('Unexpected send'); } }
  })), /no eligible movie/);
});


test('group send and rename happen only after approval', async () => {
  const events = [];
  await runCycle({ ...config, approvalChatId: '42' }, emptyState(), dependencies({
    approval: { decide: async () => { events.push('approved'); return 'approved'; } },
    telegram: { send: async () => { events.push('sent'); return { message_id: 1 }; }, renameGroup: async () => events.push('renamed') }
  }));
  assert.deepEqual(events, ['approved', 'sent', 'renamed']);
});

test('pending approval does not send or rename, then resumes', async () => {
  const state = emptyState();
  let approved = false, sends = 0;
  const deps = dependencies({
    approval: { decide: async () => approved ? 'approved' : null },
    telegram: { send: async () => ({ message_id: ++sends }), renameGroup: async () => { assert.equal(approved, true); } }
  });
  const first = await runCycle({ ...config, approvalChatId: '42' }, state, deps);
  assert.equal(first.summary.awaitingApproval, 1);
  assert.equal(sends, 0);
  assert.equal(state.pendingDelivery, null);
  approved = true;
  await runCycle({ ...config, approvalChatId: '42' }, state, deps);
  assert.equal(sends, 1);
});

test('rejection skips a movie permanently without posting it', async () => {
  const state = emptyState();
  const deps = dependencies({ approval: { decide: async () => 'rejected' },
    telegram: { send: async () => assert.fail('Rejected movie sent'), renameGroup: async () => assert.fail('Group renamed') } });
  await runCycle({ ...config, approvalChatId: '42' }, state, deps);
  await runCycle({ ...config, approvalChatId: '42' }, state, deps);
  assert.ok(Object.values(state.items).some(item => item.status === 'rejected'));
});

test('configured approval cannot be bypassed by a missing client', async () => {
  await assert.rejects(runCycle({ ...config, approvalChatId: '42' }, emptyState(), dependencies()), /Approval client is required/);
});


test('many movies remain queued while one approval waits, then the next movie is offered', async () => {
  const state = emptyState();
  for (let i = 0; i < 3; i++) state.items['movie-' + i] = { status: 'queued', firstSeen: String(i),
    movie: { title: 'Movie ' + i, year: '2024', languages: ['Hindi'], links: [], rating: 7 } };
  const offered = [];
  let approveFirst = false, sends = 0;
  const deps = dependencies({
    approval: { decide: async movie => { offered.push(movie.title); return approveFirst && movie.title === 'Movie 0' ? 'approved' : null; } },
    telegram: { send: async () => ({ message_id: ++sends }) }
  });
  const cfg = { ...config, sources: [], approvalChatId: '42' };
  await runCycle(cfg, state, deps);
  assert.equal(Object.values(state.items).filter(item => item.status === 'queued').length, 3);
  assert.equal(sends, 0);
  approveFirst = true;
  await runCycle(cfg, state, deps);
  assert.equal(sends, 1);
  assert.equal(Object.values(state.items).filter(item => item.status === 'queued').length, 2);
  assert.deepEqual(offered, ['Movie 0', 'Movie 0', 'Movie 1']);
});


test('redirected catalog uses the final origin and preserves pagination progress across runs', async () => {
  const state = emptyState();
  const destination = 'https://new.example/';
  const redirectedListing = listing.replaceAll('href="/', 'href="' + destination)
    .replace('</body>', '<a rel="next" href="' + destination + 'page/2/">Next</a></body>');
  let sends = 0;
  const deps = dependencies({
    get: async url => url === source.url
      ? { html: redirectedListing, url: destination }
      : url === destination + 'page/2/' ? { html: listing, url }
        : { html: detail, url },
    telegram: { send: async () => ({ message_id: ++sends }) }
  });
  await runCycle(config, state, deps);
  assert.equal(state.sources[source.url].backfillUrl, destination + 'page/2/');
  assert.equal(state.sources[source.url].backfillDone, false);
  assert.equal(sends, 1);
  await runCycle(config, state, deps);
  assert.equal(state.sources[source.url].backfillDone, true);
  assert.equal(sends, 1);
});

test('old queued detail URLs resolve relative links against the redirected page', async () => {
  const state = emptyState();
  state.items.old = { status: 'queued', firstSeen: '2024', url: source.url + 'journey-2024/' };
  let sent;
  await runCycle({ ...config, sources: [] }, state, dependencies({
    get: async () => ({ html: detail, url: 'https://new.example/journey-2024/' }),
    telegram: { send: async movie => { sent = movie; return { message_id: 1 }; } }
  }));
  assert.equal(sent.url, 'https://new.example/journey-2024/');
  assert.equal(sent.poster, 'https://new.example/poster.jpg');
  assert.equal(state.items.old.status, 'sent');
});
