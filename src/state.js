import { readFile, writeFile, mkdir, rename, open, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export function emptyState() {
  return { version: 1, sources: {}, items: {}, movies: {}, pendingDelivery: null, lastRun: null };
}
export async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.sources || !state.items || !state.movies) throw new Error('Invalid state format.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error('Cannot read posting history. Restore a valid state file before running; history was not reset.');
  }
}
export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  const file = await open(tmp, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(state) + '\n');
    await file.sync();
  } finally { await file.close(); }
  await rename(tmp, path);
}
export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = path + '.lock';
  let file;
  try { file = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = await stat(lockPath);
    if (Date.now() - lock.mtimeMs < 4 * 60 * 60 * 1000) throw new Error('Another run holds the state lock.');
    await unlink(lockPath);
    file = await open(lockPath, 'wx');
  }
  await file.writeFile(String(process.pid));
  return async () => { await file.close(); await unlink(lockPath); };
}

export function confirmDelivery(state, messageId = null) {
  const pending = state.pendingDelivery;
  if (!pending) throw new Error('No uncertain delivery to resolve.');
  for (const key of pending.keys) {
    state.movies[key] = {
      title: pending.title, year: pending.year, sentAt: new Date().toISOString(), messageId
    };
  }
  const item = state.items[pending.itemId];
  item.status = 'sent';
  item.sentAt = new Date().toISOString();
  item.messageId = messageId;
  delete item.movie;
  state.pendingDelivery = null;
}
