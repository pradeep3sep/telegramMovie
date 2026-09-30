import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { formatRating } from './rating.js';
import { readState, acquireLock } from './state.js';
import { runCycle } from './runner.js';
import { TelegramClient } from './telegram.js';
import { MetadataClient } from './metadata.js';
import { createDurableSaver, checkpoint } from '../scripts/github-state.js';

async function main() {
  const config = await loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const previewArg = process.argv.find(value => value.startsWith('--preview-limit='));
  const previewLimit = previewArg ? Number(previewArg.split('=')[1]) : 3;
  if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > 20) throw new Error('Preview limit must be from 1 to 20.');
  if (!dryRun && (!config.token || !config.chatId)) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env or GitHub Actions secrets. Use npm run dry-run to inspect without sending.');
  }
  const unlock = dryRun ? async () => {} : await acquireLock(config.statePath);
  try {
    const state = dryRun ? structuredClone(await readState(config.statePath)) : await readState(config.statePath);
    const telegram = dryRun ? undefined : new TelegramClient(config);
    if (telegram) await telegram.verify();
    const metadata = new MetadataClient(config.omdbKey, config.omdbBudget);
    const result = await runCycle(config, state, {
      dryRun, telegram, metadata, previewLimit,
      save: dryRun ? async () => {} : createDurableSaver(config.statePath, process.env.STATE_GIT_DIR)
    });
    if (dryRun) {
      await mkdir('output', { recursive: true });
      await writeFile('output/preview.json', JSON.stringify(result.preview, null, 2) + '\n');
      for (const movie of result.preview) {
        console.log('\n' + movie.title + (movie.year ? ' (' + movie.year + ')' : ''));
        console.log('  Audio: ' + movie.languages.join(', ') + ' | IMDb : ' + formatRating(movie.rating));
        console.log('  Poster: ' + (movie.poster ? 'available' : 'not available') + ' | Download options: ' + movie.links.length);
      }
      console.log('Preview written to output/preview.json. No Telegram messages or posting history were changed.');
    }
  } finally {
    try { if (!dryRun && process.env.STATE_GIT_DIR) checkpoint(process.env.STATE_GIT_DIR); }
    finally { await unlock(); }
  }
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
