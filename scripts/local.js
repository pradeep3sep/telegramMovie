import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runScheduled } from '../src/scheduler.js';

async function main() {
  const testMode = process.argv.includes('--test');
  const hours = Number(process.env.LOCAL_INTERVAL_HOURS?.trim() || 6);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('LOCAL_INTERVAL_HOURS must be an integer from 1 to 168.');
  const config = await loadConfig();
  if (!config.token || !config.chatId) throw new Error('Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first. npm run dry-run works without them.');
  const controller = new AbortController();
  let child;
  const stop = () => {
    controller.abort();
    if (child && child.exitCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const cycle = () => new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...(testMode ? {
        MAX_MESSAGES_PER_RUN: '1', MAX_CATALOG_PAGES_PER_RUN: '1',
        MAX_RECENT_PAGES_PER_RUN: '1', MAX_OMDB_REQUESTS_PER_RUN: '20',
        MAX_RUNTIME_MINUTES: '5'
      } : {})
    };
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
      cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local cycle did not complete successfully.')));
  });
  try {
    if (testMode) {
      console.log('Local Telegram test: at most one movie will be posted using the normal saved history.');
      await cycle();
    } else {
      console.log('Running locally every ' + hours + ' hours. Keep this terminal open; press Ctrl+C to stop.');
      await runScheduled({ cycle, intervalMs: hours * 3600000, signal: controller.signal });
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
