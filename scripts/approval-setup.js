import 'dotenv/config';
import { TelegramClient } from '../src/telegram.js';
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN in .env first.');
  const client = new TelegramClient({ token: process.env.TELEGRAM_BOT_TOKEN });
  const bot = await client.call('getMe');
  console.log('Send /start in your PRIVATE chat with @' + bot.username + ', then run this command again.');
  const updates = await client.call('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  const ids = new Set();
  for (const update of updates) {
    const message = update.message;
    if (message?.chat?.type === 'private' && message.text?.startsWith('/start') && message.from?.id === message.chat.id) ids.add(message.chat.id);
  }
  if (!ids.size) console.log('No private /start found yet.');
  for (const id of ids) console.log('TELEGRAM_APPROVAL_CHAT_ID=' + id);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
