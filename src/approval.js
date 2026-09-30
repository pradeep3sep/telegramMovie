import { randomUUID } from 'node:crypto';
import { TelegramClient, TelegramError } from './telegram.js';

export class ApprovalClient {
  constructor(config, options = {}) {
    this.chatId = config.approvalChatId;
    this.destination = config.chatId;
    this.client = new TelegramClient({ ...config, chatId: this.chatId, threadId: undefined }, options);
  }
  async verify() {
    await this.client.verify();
    if (this.client.chatType !== 'private') throw new Error('TELEGRAM_APPROVAL_CHAT_ID must identify your private chat.');
    const webhook = await this.client.call('getWebhookInfo');
    if (webhook.url) throw new Error('Approval polling requires a bot without an active webhook.');
  }
  async cleanup(approval, state, { save, log = console.log }) {
    if (!approval?.decision || !approval.messageId || approval.cleaned) return;
    const data = { chat_id: approval.owner, message_id: approval.messageId };
    try {
      await this.client.call('deleteMessage', data);
    } catch (error) {
      if (error instanceof TelegramError && error.code === 400 && /message to delete not found/i.test(error.description)) {
        // A previous deletion may have succeeded before the process stopped.
      } else if (error instanceof TelegramError && error.code === 400 && /can't be deleted|cannot be deleted/i.test(error.description)) {
        try {
          await this.client.call('editMessageReplyMarkup', { ...data, reply_markup: { inline_keyboard: [] } });
          log('Telegram could not delete an old approval message; its buttons were removed.');
        } catch {
          log('Approval message cleanup failed; it will be retried.');
          return;
        }
      } else {
        log('Approval message cleanup failed; it will be retried.');
        return;
      }
    }
    approval.cleaned = true;
    await save(state);
  }
  async cleanupDecided(state, options) {
    for (const item of Object.values(state.items)) await this.cleanup(item.approval, state, options);
  }
  async decide(movie, item, state, { save, deadline, now = () => Date.now(), log = console.log }) {
    if (!item.approval || item.approval.owner !== this.chatId || item.approval.destination !== this.destination) {
      item.approval = { token: randomUUID(), owner: this.chatId, destination: this.destination };
      await save(state);
    }
    const approval = item.approval;
    if (approval.decision) {
      await this.cleanup(approval, state, { save, log });
      return approval.decision;
    }
    if (!approval.messageId) {
      const result = await this.client.send(movie, {
        captionSuffix: '\n\nPublish this movie to the group?',
        extraButtons: [
          { text: 'Approve', callback_data: 'approve:' + approval.token },
          { text: 'Reject', callback_data: 'reject:' + approval.token }
        ]
      });
      approval.messageId = result.message_id;
      await save(state);
    }
    log('Waiting for your Telegram approval: ' + movie.title);
    while (now() < deadline - 60000) {
      const updates = await this.client.call('getUpdates', {
        offset: state.approvalOffset || 0, timeout: 20, allowed_updates: ['callback_query', 'message', 'my_chat_member']
      });
      for (const update of updates) {
        const query = update.callback_query;
        const action = query?.data === 'approve:' + approval.token ? 'approved'
          : query?.data === 'reject:' + approval.token ? 'rejected' : null;
        if (action && String(query.from?.id) === this.chatId &&
            String(query.message?.chat?.id) === this.chatId && query.message?.chat?.type === 'private') {
          // Save the decision before acknowledging/consuming its update.
          approval.decision = action;
        }
        state.approvalOffset = update.update_id + 1;
        await save(state);
        if (query) {
          try { await this.client.call('answerCallbackQuery', {
            callback_query_id: query.id, text: approval.decision && action ? 'Decision saved.' : 'This request is no longer active.'
          }); } catch { log('Could not acknowledge the button; saved decisions are preserved.'); }
        }
        if (approval.decision) {
          await this.cleanup(approval, state, { save, log });
          return approval.decision;
        }
      }
    }
    log('Approval is still pending. Keep npm run local running, or run the test again to resume.');
    return null;
  }
}
