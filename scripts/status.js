import { loadConfig } from '../src/config.js';
import { readState } from '../src/state.js';
const config = await loadConfig();
const state = await readState(config.statePath);
const counts = {};
for (const item of Object.values(state.items)) counts[item.status] = (counts[item.status] || 0) + 1;
console.log(JSON.stringify({ counts, sources: state.sources, pendingDelivery: state.pendingDelivery, lastRun: state.lastRun }, null, 2));
