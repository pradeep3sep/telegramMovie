import { setTimeout as sleep } from 'node:timers/promises';
import { formatRating } from './rating.js';

export class TelegramError extends Error {
  constructor(code, description, method) {
    super('Telegram rejected ' + (method || 'the request') + ' (code ' + code + ')' + (description ? ': ' + description : '.'));
    this.code = code;
    this.description = description || '';
  }
}
export class TelegramRequestError extends Error {
  constructor(method) {
    super('Telegram ' + method + ' failed after retries. Pending approvals are preserved; resume on the next run.');
    this.method = method;
  }
}
export class UncertainDeliveryError extends Error {
  constructor() {
    super('Telegram delivery could not be confirmed. Posting is paused to prevent a duplicate; check the group and resolve the pending delivery.');
  }
}
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatPost(movie) {
  const heading = escape(movie.title.slice(0, 180)) + (movie.year ? ' (' + escape(movie.year) + ')' : '');
  const rating = formatRating(movie.rating);
  const caption = '<b>' + heading + '</b>\n\n' +
    'Audio: ' + escape(movie.languages.join(', ')) + '\n' +
    'IMDb : ' + escape(rating) +
    '\n\nChoose a download option below.' +
    (movie.links.length > 24 ? '\nShowing the first 24 download options.' : '');
  const buttons = movie.links.slice(0, 24).map(link => ({ text: link.label, url: link.url }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { caption, reply_markup: { inline_keyboard: rows } };
}

export function formatGroupTitle(movieTitle) {
  const suffix = ' Latest Movie';
  let title = '';
  for (const character of String(movieTitle || '').replace(/\s+/g, ' ').trim()) {
    if (title.length + character.length > 128 - suffix.length) break;
    title += character;
  }
  return title.trimEnd() + suffix;
}

export class TelegramClient {
  constructor({ token, chatId, threadId }, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
    this.token = token;
    this.chatId = chatId;
    this.threadId = threadId;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }
  async call(method, data = {}) {
    const retryableRead = ['getMe', 'getChat', 'getWebhookInfo', 'getUpdates'].includes(method);
    for (let attempt = 0; attempt < 4; attempt++) {
      let response, body;
      try {
        response = await this.fetch('https://api.telegram.org/bot' + this.token + '/' + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(45000)
        });
        body = await response.json();
      } catch {
        if (!retryableRead) throw new UncertainDeliveryError();
        if (attempt === 3) throw new TelegramRequestError(method);
        await this.sleep(1500 * 2 ** attempt);
        continue;
      }
      // Reads can safely retry; a send may already have reached Telegram.
      if (response.status >= 500) {
        if (!retryableRead) throw new UncertainDeliveryError();
        if (attempt === 3) throw new TelegramRequestError(method);
        await this.sleep(1500 * 2 ** attempt);
        continue;
      }
      if (body.ok) return body.result;
      // Telegram explicitly rejected the old group ID, so retry with its replacement.
      const migratedId = body.parameters?.migrate_to_chat_id;
      if (body.error_code === 400 && Number.isSafeInteger(migratedId) && data.chat_id && attempt < 3) {
        this.chatId = String(migratedId);
        data = { ...data, chat_id: this.chatId };
        continue;
      }
      if ((body.error_code === 429 || response.status === 429) && attempt < 3) {
        const seconds = Number(body.parameters?.retry_after);
        await this.sleep((Number.isFinite(seconds) ? Math.max(seconds, 1) : 10) * 1000 + 250);
        continue;
      }
      const description = String(body.description || '').split(this.token).join('[redacted]');
      throw new TelegramError(body.error_code || response.status, description, method);
    }
  }
  async verify() {
    const bot = await this.call('getMe');
    this.username = bot.username;
    const chat = await this.call('getChat', { chat_id: this.chatId });
    this.chatType = chat.type;
    if (!['group', 'supergroup', 'channel', 'private'].includes(chat.type)) throw new Error('Unsupported Telegram destination.');
  }
  async renameGroup(movieTitle) {
    if (this.chatType === 'private') return;
    try {
      await this.call('setChatTitle', { chat_id: this.chatId, title: formatGroupTitle(movieTitle) });
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 400 ||
          !/title is not modified|chat_not_modified/i.test(error.description)) throw error;
    }
  }
  async send(movie, { extraButtons = [], captionSuffix = '' } = {}) {
    const formatted = formatPost(movie);
    formatted.caption += captionSuffix;
    if (extraButtons.length) formatted.reply_markup.inline_keyboard.push(extraButtons);
    const common = {
      chat_id: this.chatId, parse_mode: 'HTML',
      reply_markup: formatted.reply_markup,
      ...(this.threadId ? { message_thread_id: Number(this.threadId) } : {})
    };
    if (movie.poster) {
      try {
        return await this.call('sendPhoto', { ...common, photo: movie.poster, caption: formatted.caption });
      } catch (error) {
        // Fall back only after Telegram explicitly rejects the photo, not an uncertain send.
        if (!(error instanceof TelegramError) || error.code !== 400 ||
            !/photo|image|file identifier|HTTP URL|webpage|wrong type|failed to get/i.test(error.description)) throw error;
      }
    }
    return this.call('sendMessage', {
      ...common, text: formatted.caption,
      link_preview_options: { is_disabled: true }
    });
  }
}
