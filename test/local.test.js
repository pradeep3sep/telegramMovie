import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupLocal } from '../scripts/setup-local.js';
import { runScheduled } from '../src/scheduler.js';

test('local setup creates .env once and preserves credentials on repeated setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'movie-local-test-'));
  try {
    await setupLocal(root, () => {});
    assert.match(await readFile(join(root, '.env'), 'utf8'), /TELEGRAM_BOT_TOKEN=/);
    await writeFile(join(root, '.env'), 'TELEGRAM_BOT_TOKEN=local-test-value\n');
    await setupLocal(root, () => {});
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'TELEGRAM_BOT_TOKEN=local-test-value\n');
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\movie-local-test-') ||
      resolve(root).startsWith(resolve(tmpdir()) + '/movie-local-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('local scheduler waits the remainder of six hours and runs cycles sequentially', async () => {
  const controller = new AbortController();
  const interval = 6 * 3600000;
  let timestamp = 0, cycles = 0, active = 0;
  const waits = [];
  await runScheduled({
    intervalMs: interval, signal: controller.signal, now: () => timestamp, log: () => {},
    cycle: async () => {
      assert.equal(active++, 0);
      cycles++;
      timestamp += 1000;
      active--;
      if (cycles === 2) controller.abort();
    },
    wait: async ms => { waits.push(ms); timestamp += ms; }
  });
  assert.equal(cycles, 2);
  assert.deepEqual(waits, [interval - 1000]);
});

test('a failed cycle does not stop the local schedule', async () => {
  const controller = new AbortController();
  let cycles = 0, waits = 0;
  await runScheduled({
    intervalMs: 1000, signal: controller.signal, log: () => {},
    cycle: async () => {
      cycles++;
      if (cycles === 1) throw new Error('Temporary source failure');
      controller.abort();
    },
    wait: async () => { waits++; }
  });
  assert.equal(cycles, 2);
  assert.equal(waits, 1);
});
