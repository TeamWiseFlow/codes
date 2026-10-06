import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeNoticeRegistry } from './notices.mjs';
import { GroupMessageBuffer } from './conversations.mjs';

const appMessage = (messageId, content, chatId = 'group') => ({
  messageId, chatId, content, raw: { sender: { sender_type: 'app' } },
});

test('cross-bot notices are identified even before the send response', async () => {
  const registry = new BridgeNoticeRegistry();
  const text = 'relay:group:group 会话已重置';
  await registry.send('group', text, async () => {
    assert.equal(registry.isNotice(appMessage('notice', text)), true);
    assert.equal(registry.isNotice({ ...appMessage('user-quote', text), raw: { sender: { sender_type: 'user' } } }), false);
    assert.equal(registry.isNotice(appMessage('other-chat', text, 'other-group')), false);
    assert.equal(registry.isNotice(appMessage('analysis', '有价值的分析结论')), false);
    return { messageId: 'notice' };
  });
  assert.equal(registry.isNotice(appMessage('notice', text)), true);
  // Same wording alone is not a filter after the send completes.
  assert.equal(registry.isNotice(appMessage('final-answer-quote', text)), false);
});

test('SDK chunks and raw API message IDs are all remembered', async () => {
  const registry = new BridgeNoticeRegistry();
  await registry.send('group', ['first part', 'second part'], async () => {
    assert.equal(registry.isNotice(appMessage('second', 'second part')), true);
    return { messageId: 'first', chunkIds: ['first', 'second'] };
  });
  await registry.send('group', 'fallback', async () => ({ data: { message_id: 'raw' } }));
  assert.equal(registry.has('first'), true);
  assert.equal(registry.has('second'), true);
  assert.equal(registry.has('raw'), true);
});

test('identical concurrent notices retain their pending classification independently', async () => {
  const registry = new BridgeNoticeRegistry();
  let finish;
  const slow = registry.send('group', '排队提示', () => new Promise((resolve) => { finish = resolve; }));
  await registry.send('group', '排队提示', async () => ({ messageId: 'fast' }));
  assert.equal(registry.isNotice(appMessage('slow', '排队提示')), true);
  finish({ messageId: 'slow' });
  await slow;
  assert.equal(registry.isNotice(appMessage('unrelated', '排队提示')), false);
});

test('failed sends cannot leave a permanent text filter', async () => {
  const registry = new BridgeNoticeRegistry();
  await assert.rejects(registry.send('group', '发送中', async () => { throw new Error('send failed'); }), /send failed/);
  assert.equal(registry.isNotice(appMessage('later', '发送中')), false);
});

test('notice IDs survive restart and prune only their buffered records', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notices-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notices.json');
  await new BridgeNoticeRegistry(file).send('group', '回执', async () => ({ messageId: 'notice' }));
  const restored = new BridgeNoticeRegistry(file);
  const buffer = new GroupMessageBuffer(path.join(dir, 'groups.json'));
  buffer.append('relay:group:g', { messageId: 'notice', content: '回执' });
  buffer.append('relay:group:g', { messageId: 'human', content: '用户引用回执' });
  buffer.append('codes:group:g', { messageId: 'notice', content: '回执' });
  buffer.append('codes:group:h', { messageId: 'final', content: '其他群的 AI 结论' });
  assert.equal(buffer.prune((record) => restored.has(record.messageId)), 2);
  assert.deepEqual(buffer.take('relay:group:g').map((record) => record.messageId), ['human']);
  assert.equal(buffer.count('codes:group:g'), 0);
  assert.equal(buffer.count('codes:group:h'), 1);
  assert.equal(new GroupMessageBuffer(path.join(dir, 'groups.json')).count('codes:group:h'), 1);
});

test('failed buffer pruning restores records in memory', () => {
  const buffer = new GroupMessageBuffer();
  buffer.append('group', { messageId: 'notice', content: '保留到成功落盘' });
  buffer.save = () => { throw new Error('storage unavailable'); };
  assert.throws(() => buffer.prune(() => true), /storage unavailable/);
  assert.equal(buffer.count('group'), 1);
});

test('notice history remains bounded', () => {
  const registry = new BridgeNoticeRegistry(null, { maxEntries: 2 });
  for (const id of ['one', 'two', 'three']) registry.remember(id);
  assert.equal(registry.has('one'), false);
  assert.equal(registry.has('two'), true);
  assert.equal(registry.has('three'), true);
});
