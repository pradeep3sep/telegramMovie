import { setTimeout as sleep } from 'node:timers/promises';

export async function runScheduled({
  cycle, intervalMs, signal, log = console.log, now = () => Date.now(),
  wait = (ms, signal) => sleep(ms, undefined, { signal })
}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Schedule interval must be positive.');
  while (!signal?.aborted) {
    const started = now();
    try { await cycle(); }
    catch {
      if (signal?.aborted) break;
      log('Cycle failed. Inspect the output above; saved progress will be used next time.');
    }
    if (signal?.aborted) break;
    const delay = Math.max(0, started + intervalMs - now());
    log('Next local cycle: ' + new Date(now() + delay).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST');
    try { await wait(delay, signal); }
    catch (error) {
      if (signal?.aborted) break;
      throw error;
    }
  }
}
