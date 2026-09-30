import 'dotenv/config';
import { TelegramClient } from '../src/telegram.js';
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Create .env and set TELEGRAM_BOT_TOKEN first.');
  const client = new TelegramClient({ token: process.env.TELEGRAM_BOT_TOKEN });
  const bot = await client.call('getMe');
  console.log('Bot connected: @' + bot.username);
  console.log('Add this bot to your group and send /start@' + bot.username + ' there, then run this command again.');
  const updates = await client.call('getUpdates', { timeout: 0, allowed_updates: ['message', 'my_chat_member'] });
  const chats = new Map();
  for (const update of updates) {
    const message = update.message;
    const chat = message?.chat || update.my_chat_member?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, title: chat.title || chat.first_name, thread: message?.message_thread_id });
  }
  if (!chats.size) console.log('No recent group updates. Send the command in your group, then try again.');
  for (const chat of chats.values()) {
    console.log(JSON.stringify(chat));
    console.log('TELEGRAM_CHAT_ID=' + chat.id);
    if (chat.thread) console.log('TELEGRAM_THREAD_ID=' + chat.thread);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
