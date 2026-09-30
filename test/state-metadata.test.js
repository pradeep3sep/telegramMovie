import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, readState, saveState, acquireLock } from '../src/state.js';
import { MetadataClient } from '../src/metadata.js';
import { createDurableSaver, checkpoint, git } from '../scripts/github-state.js';
import { execFileSync } from 'node:child_process';

test('history survives saves, rejects corruption and prevents overlapping writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-bot-test-'));
  try {
    const path = join(dir, 'state.json');
    const state = emptyState();
    state.movies['title:example:2024'] = { sentAt: '2026-09-30' };
    await saveState(path, state);
    assert.deepEqual(await readState(path), state);
    const unlock = await acquireLock(path);
    await assert.rejects(acquireLock(path), /Another run/);
    await unlock();
    await writeFile(path, 'broken json');
    await assert.rejects(readState(path), /history was not reset/);
  } finally {
    assert.ok(dir.startsWith(join(tmpdir(), 'movie-')), 'Temporary cleanup must stay inside the named test directory.');
    await rm(dir, { recursive: true, force: true });
  }
});
test('OMDb requests have a budget and reject mismatched titles', async () => {
  let calls = 0;
  const client = new MetadataClient('test-key', 1, {
    log: () => {},
    get: async () => {
      calls++;
      return JSON.stringify({ Response: 'True', Type: 'movie', Title: 'Different Movie', Year: '2024', imdbRating: '9.9', imdbID: 'tt9999999' });
    }
  });
  const movie = { title: 'Example', year: '2024', rating: null };
  assert.deepEqual(await client.enrich(movie), movie);
  await client.enrich({ title: 'Another', year: '2024' });
  assert.equal(calls, 1);
});
test('valid OMDb match supplies an IMDb rating and poster', async () => {
  const client = new MetadataClient('test-key', 1, { get: async () => JSON.stringify({
    Response: 'True', Type: 'movie', Title: 'Example', Year: '2024', imdbRating: '7.2',
    imdbID: 'tt1234567', Poster: 'https://example.com/poster.jpg'
  }) });
  const movie = await client.enrich({ title: 'Example', year: '2024' });
  assert.equal(movie.rating, '7.2');
  assert.equal(movie.ratingSource, 'OMDb / IMDb');
});
test('delivery intent and completion reach the remote history branch before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'movie-git-test-'));
  const remote = join(dir, 'remote.git'), work = join(dir, 'work');
  try {
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['init', '--quiet', work]);
    git(work, ['config', 'user.name', 'Test']);
    git(work, ['config', 'user.email', 'test@example.com']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['checkout', '--quiet', '--orphan', 'movie-bot-state']);
    const path = join(work, 'state.json');
    const state = emptyState();
    await saveState(path, state);
    checkpoint(work);
    const saver = createDurableSaver(path, work);
    state.pendingDelivery = { itemId: 'test', title: 'Example' };
    await saver(state);
    const savedPending = JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', 'movie-bot-state:state.json'], { encoding: 'utf8' }));
    assert.equal(savedPending.pendingDelivery.itemId, 'test');
    state.pendingDelivery = null;
    state.movies.test = { sentAt: 'now' };
    await saver(state);
    const savedDone = JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', 'movie-bot-state:state.json'], { encoding: 'utf8' }));
    assert.equal(savedDone.pendingDelivery, null);
    assert.ok(savedDone.movies.test);
  } finally {
    assert.ok(dir.startsWith(join(tmpdir(), 'movie-')), 'Temporary cleanup must stay inside the named test directory.');
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMDb missing ratings do not become zero and preserve a valid website fallback', async () => {
  for (const imdbRating of [undefined, null, '', 'N/A', '0', '0.0']) {
    for (const fallback of [null, '8']) {
      const client = new MetadataClient('test-key', 1, { get: async () => JSON.stringify({
        Response: 'True', Type: 'movie', Title: 'Example', Year: '2024',
        imdbID: 'tt1234567', imdbRating
      }) });
      const enriched = await client.enrich({ title: 'Example', year: '2024', rating: fallback });
      assert.equal(enriched.rating, fallback);
      assert.notEqual(enriched.rating, '0');
    }
  }
});
