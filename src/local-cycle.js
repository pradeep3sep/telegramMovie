import { emptyState } from './state.js';
import { runCycle } from './runner.js';
export async function runTestCycle(config, dependencies = {}) {
  const { state = emptyState(), save = async () => {}, ...rest } = dependencies;
  const result = await runCycle({ ...config, maxMessages: 1 }, state, {
    ...rest, dryRun: false, save
  });
  if (result.summary.sent !== 1 && !result.summary.awaitingApproval) throw new Error('Local test found no eligible movie to send. Check the sources and movie filters.');
  return result;
}
