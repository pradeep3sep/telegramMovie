import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { formatRating } from './rating.js';
import { readState, acquireLock, emptyState, saveState } from './state.js';
import { runCycle } from './runner.js';
import { runTestCycle } from './local-cycle.js';
import { TelegramClient } from './telegram.js';
import { ApprovalClient } from './approval.js';
import { MetadataClient } from './metadata.js';
import { createDurableSaver, checkpoint } from '../scripts/github-state.js';

async function main() {
  const config = await loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const testMode = process.argv.includes('--test-send');
  if (testMode && dryRun) throw new Error('Test send cannot be combined with dry-run.');
  if (!dryRun && !/^\d+$/.test(config.approvalChatId || '')) throw new Error('Set TELEGRAM_APPROVAL_CHAT_ID to your private chat ID. Send /start to the bot privately, then run npm run approval:setup.');
  const previewArg = process.argv.find(value => value.startsWith('--preview-limit='));
  const previewLimit = previewArg ? Number(previewArg.split('=')[1]) : 3;
  if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > 20) throw new Error('Preview limit must be from 1 to 20.');
  if (!dryRun && (!config.token || !config.chatId)) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env or GitHub Actions secrets. Use npm run dry-run to inspect without sending.');
  }
  const unlock = dryRun ? async () => {} : await acquireLock(config.statePath);
  try {
    const testPath = config.statePath + '.test.json';
    const otherState = await readState(testMode ? config.statePath : testPath);
    if (otherState.pendingDelivery || Object.values(otherState.items).some(item => item.status === 'queued' && item.approval && !item.approval.decision)) {
      throw new Error('Finish the pending delivery/approval using ' + (testMode ? 'npm start' : 'npm run local:testit') + ' before switching modes.');
    }
    let state = await readState(testMode ? testPath : config.statePath);

    const telegram = dryRun ? undefined : new TelegramClient(config);
    if (telegram) await telegram.verify();
    const approval = dryRun ? undefined : new ApprovalClient(config);
    if (approval) {
      await approval.verify();
      await approval.cleanupDecided(state, { save: testMode ? s => saveState(testPath, s) : createDurableSaver(config.statePath, process.env.STATE_GIT_DIR) });
    }
    if (testMode && !state.pendingDelivery && !Object.values(state.items).some(item =>
      (item.status === 'queued' && item.approval) || (item.approval?.decision && item.approval.messageId && !item.approval.cleaned))) state = emptyState();
    const metadata = new MetadataClient(config.omdbKey, config.omdbBudget);
    const dependencies = {
      dryRun, telegram, approval, metadata, previewLimit,
      save: dryRun ? async () => {} : testMode ? s => saveState(testPath, s) : createDurableSaver(config.statePath, process.env.STATE_GIT_DIR)
    };
    const result = testMode ? await runTestCycle(config, { ...dependencies, state }) : await runCycle(config, state, dependencies);
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
    try { if (!dryRun && !testMode && process.env.STATE_GIT_DIR) checkpoint(process.env.STATE_GIT_DIR); }
    finally { await unlock(); }
  }
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
