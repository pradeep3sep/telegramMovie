import { execFileSync } from 'node:child_process';
import { mkdir, appendFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyState, saveState } from '../src/state.js';

export function git(dir, args, acceptedCodes = [0]) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000
    }).trim();
  } catch (error) {
    if (acceptedCodes.includes(error.status)) return null;
    throw new Error('GitHub state operation failed (' + args[0] + '). Posting has stopped; inspect repository permissions and connectivity.');
  }
}
export function checkpoint(dir) {
  git(dir, ['add', '--', 'state.json']);
  if (!git(dir, ['diff', '--cached', '--name-only'])) return;
  git(dir, ['commit', '--quiet', '-m', 'Save movie notification progress']);
  git(dir, ['push', '--quiet', 'origin', 'HEAD:movie-bot-state']);
}
export function createDurableSaver(path, gitDir) {
  let previousPending = null, previousApprovals = null, lastCheckpoint = 0;
  return async state => {
    await saveState(path, state);
    if (!gitDir) return;
    const pending = state.pendingDelivery?.itemId || null;
    // Save the intent before Telegram and confirmation immediately afterwards.
    const approvals = JSON.stringify(Object.values(state.items).filter(item => item.approval).map(item => item.approval));
    if (approvals !== previousApprovals || pending !== previousPending || Date.now() - lastCheckpoint > 60000) {
      checkpoint(gitDir);
      previousPending = pending;
      previousApprovals = approvals;
      lastCheckpoint = Date.now();
    }
  };
}
async function prepare() {
  const { RUNNER_TEMP, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_ENV } = process.env;
  if (!RUNNER_TEMP || !GITHUB_REPOSITORY || !GITHUB_TOKEN || !GITHUB_ENV) throw new Error('This command runs inside GitHub Actions only.');
  const dir = resolve(RUNNER_TEMP, 'movie-bot-state');
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/' + GITHUB_REPOSITORY + '.git']);
  const auth = Buffer.from('x-access-token:' + GITHUB_TOKEN).toString('base64');
  git(dir, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic ' + auth]);
  git(dir, ['config', 'user.name', 'github-actions[bot]']);
  git(dir, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const branch = git(dir, ['ls-remote', '--exit-code', '--heads', 'origin', 'movie-bot-state'], [0, 2]);
  if (branch) {
    git(dir, ['fetch', '--quiet', '--depth=1', 'origin', 'movie-bot-state']);
    git(dir, ['checkout', '--quiet', '-b', 'movie-bot-state', 'FETCH_HEAD']);
    try { await access(join(dir, 'state.json')); }
    catch { throw new Error('Existing history branch is missing state.json. Restore history; it was not reset.'); }
  } else {
    git(dir, ['checkout', '--quiet', '--orphan', 'movie-bot-state']);
    await saveState(join(dir, 'state.json'), emptyState());
    checkpoint(dir);
  }
  await appendFile(GITHUB_ENV, 'STATE_PATH=' + join(dir, 'state.json') + '\nSTATE_GIT_DIR=' + dir + '\n');
  console.log('Durable posting history is ready on movie-bot-state.');
}
const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  Promise.resolve().then(() => {
    if (process.argv[2] === 'prepare') return prepare();
    if (process.argv[2] === 'checkpoint') {
      if (!process.env.STATE_GIT_DIR) throw new Error('STATE_GIT_DIR is not configured.');
      return checkpoint(process.env.STATE_GIT_DIR);
    }
    throw new Error('Use prepare or checkpoint.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
