import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function setupLocal(root = process.cwd(), log = console.log) {
  const path = resolve(root, '.env');
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  try {
    await writeFile(path, template, { flag: 'wx', mode: 0o600 });
    log('Created .env. Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before sending.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    log('Existing .env kept unchanged.');
  }
  await mkdir(resolve(root, 'data'), { recursive: true });
  await mkdir(resolve(root, 'output'), { recursive: true });
  log('Preview without sending: npm run dry-run');
  log('Send one movie to test Telegram: npm run local:test');
  log('Run a full cycle: npm start');
  log('Run recurring cycles locally: npm run local');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupLocal().catch(error => { console.error(error.message); process.exitCode = 1; });
}
