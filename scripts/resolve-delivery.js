import { loadConfig } from '../src/config.js';
import { readState, saveState, confirmDelivery, acquireLock } from '../src/state.js';
import { checkpoint } from './github-state.js';
async function main() {
  const action = process.argv[2];
  if (!['mark-sent', 'retry'].includes(action)) throw new Error('Use mark-sent if the movie is already in the group, or retry only after confirming it is absent.');
  const config = await loadConfig();
  const unlock = await acquireLock(config.statePath);
  try {
    const state = await readState(config.statePath);
    if (!state.pendingDelivery) throw new Error('There is no uncertain delivery to resolve.');
    console.log('Resolving pending movie: ' + state.pendingDelivery.title);
    if (action === 'mark-sent') confirmDelivery(state);
    else state.pendingDelivery = null;
    await saveState(config.statePath, state);
    if (process.env.STATE_GIT_DIR) checkpoint(process.env.STATE_GIT_DIR);
    console.log('Delivery resolved: ' + action);
  } finally { await unlock(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
