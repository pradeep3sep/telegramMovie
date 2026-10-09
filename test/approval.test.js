import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalClient } from '../src/approval.js';
import { emptyState } from '../src/state.js';
const movie = { title: 'Example', year: '2024', languages: ['Hindi'], rating: 7, links: [] };
const config = { token: 'test', chatId: '-123', approvalChatId: '42' };
const opts = { save: async () => {}, deadline: 600000, now: () => 0, log: () => {} };
const callback = (token, from = 42, action = 'approve') => ({ update_id: 3, callback_query: {
  id: 'button', from: { id: from }, message: { chat: { id: 42, type: 'private' } }, data: action + ':' + token
} });

test('only the configured user can approve, and the decision is saved before acknowledgement', async () => {
  const client = new ApprovalClient(config);
  const state = emptyState(), item = {};
  let polls = 0, saves = 0;
  client.client.call = async (method, data) => {
    if (method === 'sendMessage') {
      assert.equal(data.chat_id, '42');
      assert.deepEqual(data.reply_markup.inline_keyboard.at(-1).map(button => button.text), ['Approve', 'Reject']);
      return { message_id: 7 };
    }
    if (method === 'getUpdates') return [callback(item.approval.token, ++polls === 1 ? 99 : 42)];
    if (method === 'answerCallbackQuery' && polls === 2) assert.equal(item.approval.decision, 'approved');
    return true;
  };
  assert.equal(await client.decide(movie, item, state, { ...opts, save: async () => { saves++; } }), 'approved');
  assert.equal(polls, 2);
  assert.equal(state.approvalOffset, 4);
  assert.ok(saves >= 4);
});

test('timeout leaves approval pending and restart reuses its preview', async () => {
  const state = emptyState(), item = {};
  const client = new ApprovalClient(config);
  let sends = 0;
  client.client.call = async method => { if (method === 'sendMessage') { sends++; return { message_id: 7 }; } };
  assert.equal(await client.decide(movie, item, state, { ...opts, now: () => 600000 }), null);
  const resumed = JSON.parse(JSON.stringify(item));
  client.client.call = async method => {
    if (method === 'sendMessage') assert.fail('Duplicate preview');
    if (method === 'getUpdates') return [callback(resumed.approval.token, 42, 'reject')];
    return true;
  };
  assert.equal(await client.decide(movie, resumed, state, opts), 'rejected');
  assert.equal(sends, 1);
});

test('saved approval is reused without polling and destination changes require new approval', async () => {
  const client = new ApprovalClient(config), state = emptyState();
  const item = { approval: { owner: '42', destination: '-123', decision: 'approved' } };
  client.client.call = async () => assert.fail('Saved decision should not make requests');
  assert.equal(await client.decide(movie, item, state, opts), 'approved');
  client.destination = '-456';
  client.client.call = async method => { assert.equal(method, 'sendMessage'); return { message_id: 8 }; };
  assert.equal(await client.decide(movie, item, state, { ...opts, now: () => 600000 }), null);
  assert.equal(item.approval.decision, undefined);
});

test('approval destination must be private and polling cannot coexist with webhook', async () => {
  const client = new ApprovalClient(config);
  client.client.verify = async () => { client.client.chatType = 'group'; };
  await assert.rejects(client.verify(), /private chat/);
  client.client.verify = async () => { client.client.chatType = 'private'; };
  client.client.call = async () => ({ url: 'https://example.com/webhook' });
  await assert.rejects(client.verify(), /active webhook/);
});


for (const decision of ['approved', 'rejected']) {
  test(decision + ' deletes the private preview only after saving the decision', async () => {
    const client = new ApprovalClient(config), state = emptyState(), item = {};
    let savedDecision = false, deletes = 0;
    client.client.call = async (method, data) => {
      if (method === 'sendMessage') return { message_id: 7 };
      if (method === 'getUpdates') return [callback(item.approval.token, 42, decision === 'approved' ? 'approve' : 'reject')];
      if (method === 'deleteMessage') {
        assert.equal(savedDecision, true);
        assert.deepEqual(data, { chat_id: '42', message_id: 7 });
        deletes++;
      }
      return true;
    };
    assert.equal(await client.decide(movie, item, state, { ...opts, save: async () => { if (item.approval?.decision) savedDecision = true; } }), decision);
    assert.equal(deletes, 1);
    assert.equal(item.approval.cleaned, true);
  });
}

test('failed deletion preserves the decision and retries after a restart', async () => {
  const client = new ApprovalClient(config), state = emptyState();
  const item = { approval: { owner: '42', destination: '-123', decision: 'approved', messageId: 7 } };
  state.items.example = item;
  client.client.call = async () => { throw new Error('Offline'); };
  assert.equal(await client.decide(movie, item, state, opts), 'approved');
  assert.equal(item.approval.cleaned, undefined);
  client.client.call = async (method, data) => { assert.equal(method, 'deleteMessage'); assert.equal(data.message_id, 7); return true; };
  await client.cleanupDecided(state, opts);
  assert.equal(item.approval.cleaned, true);
});

test('old messages lose buttons when Telegram refuses deletion', async () => {
  const { TelegramError } = await import('../src/telegram.js');
  const client = new ApprovalClient(config), state = emptyState();
  const approval = { owner: '42', messageId: 7, decision: 'rejected' };
  const calls = [];
  client.client.call = async (method, data) => {
    calls.push(method);
    if (method === 'deleteMessage') throw new TelegramError(400, "Bad Request: message can't be deleted");
    assert.deepEqual(data.reply_markup, { inline_keyboard: [] });
    return true;
  };
  await client.cleanup(approval, state, opts);
  assert.deepEqual(calls, ['deleteMessage', 'editMessageReplyMarkup']);
  assert.equal(approval.cleaned, true);
});


const pendingItem = extra => ({ approval: { token: 'saved-token', owner: '42', destination: '-123', messageId: 7, ...extra } });

test('legacy pending preview is refreshed, retaining its token and old message for cleanup', async () => {
  const client = new ApprovalClient(config), state = emptyState(), item = pendingItem();
  const calls = [];
  client.client.call = async (method, data) => {
    calls.push(method);
    if (method === 'getUpdates') { assert.equal(data.timeout, 0); return []; }
    assert.equal(method, 'sendMessage');
    assert.equal(data.reply_markup.inline_keyboard.at(-1)[0].callback_data, 'approve:saved-token');
    return { message_id: 8 };
  };
  assert.equal(await client.decide(movie, item, state, { ...opts, now: () => 600000 }), null);
  assert.deepEqual(calls, ['getUpdates', 'sendMessage']);
  assert.equal(item.approval.messageId, 8);
  assert.equal(item.approval.sentAt, 600000);
  assert.deepEqual(item.approval.previousMessageIds, [7]);
});

test('saved button response is processed before refreshing an old preview', async () => {
  const client = new ApprovalClient(config), state = emptyState(), item = pendingItem();
  client.client.call = async method => {
    if (method === 'sendMessage') assert.fail('A saved approval must not request approval again');
    if (method === 'getUpdates') return [callback('saved-token')];
    return true;
  };
  assert.equal(await client.decide(movie, item, state, opts), 'approved');
  assert.equal(item.approval.messageId, 7);
});

test('four-hour preview refresh keeps an earlier button response valid and cleans all previews', async () => {
  const client = new ApprovalClient(config), state = emptyState(), item = pendingItem({ sentAt: 0 });
  const timestamp = 4 * 3600000, deleted = [];
  let polls = 0, sends = 0;
  client.client.call = async (method, data) => {
    if (method === 'getUpdates') return ++polls === 1 ? [] : [callback('saved-token')];
    if (method === 'sendMessage') { sends++; return { message_id: 8 }; }
    if (method === 'deleteMessage') deleted.push(data.message_id);
    return true;
  };
  assert.equal(await client.decide(movie, item, state, { ...opts, now: () => timestamp, deadline: timestamp + 600000 }), 'approved');
  assert.equal(sends, 1);
  assert.deepEqual(deleted, [7, 8]);
});

for (const from of [42, 99]) {
  test('fresh-preview commands require the configured private user (' + from + ')', async () => {
    const client = new ApprovalClient(config), state = emptyState(), item = pendingItem({ sentAt: 600000 });
    let sends = 0;
    client.client.call = async method => {
      if (method === 'getUpdates') return [{ update_id: 4, message: { from: { id: from }, chat: { id: 42, type: 'private' }, text: '/approval' } }];
      if (method === 'sendMessage') { sends++; return { message_id: 8 }; }
      return true;
    };
    assert.equal(await client.decide(movie, item, state, { ...opts, now: () => 600000 }), null);
    assert.equal(sends, from === 42 ? 1 : 0);
  });
}

test('approval polling finishes after five minutes with the request still pending', async () => {
  const client = new ApprovalClient(config), state = emptyState(), item = {};
  let timestamp = 0, polls = 0;
  client.client.call = async (method, data) => {
    if (method === 'sendMessage') return { message_id: 7 };
    assert.equal(method, 'getUpdates');
    polls++;
    timestamp += data.timeout * 1000;
    return [];
  };
  assert.equal(await client.decide(movie, item, state, { ...opts, deadline: 150 * 60000, now: () => timestamp }), null);
  assert.equal(timestamp, 5 * 60000);
  assert.equal(polls, 15);
  assert.equal(item.approval.decision, undefined);
  assert.equal(item.approval.messageId, 7);
  assert.equal(state.pendingDelivery, null);
});


test('cleanup resumes past an old preview whose buttons were already removed', async () => {
  const { TelegramError } = await import('../src/telegram.js');
  const client = new ApprovalClient(config), state = emptyState();
  const approval = { owner: '42', messageId: 8, previousMessageIds: [7], decision: 'approved' };
  const deleted = [];
  client.client.call = async (method, data) => {
    if (data.message_id === 7) {
      if (method === 'deleteMessage') throw new TelegramError(400, "Bad Request: message can't be deleted");
      throw new TelegramError(400, 'Bad Request: message is not modified');
    }
    assert.equal(method, 'deleteMessage');
    deleted.push(data.message_id);
    return true;
  };
  await client.cleanup(approval, state, opts);
  assert.deepEqual(deleted, [8]);
  assert.equal(approval.cleaned, true);
});
