import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  indexBotProjects, conversationKey, isBotMentioned,
  groupMessageRecord, buildGroupPrompt, GroupMessageBuffer,
} from './conversations.mjs';

const project = (feishu) => ({ path: '/tmp', feishu: { appId: 'same-bot', appSecretPath: '/secret', ...feishu } });

test('each bot keeps its project binding across private and group channels', () => {
  const projects = {
    'xiaobei-dev': project({ appId: 'xiaobei-bot' }),
    relay: project({ appId: 'relay-bot' }),
  };
  const bots = indexBotProjects(projects);
  assert.equal(bots.size, 2);
  assert.equal(bots.get('xiaobei-bot').alias, 'xiaobei-dev');
  assert.equal(bots.get('relay-bot').alias, 'relay');
  assert.equal(bots.get('relay-bot').project, projects.relay);
  assert.notEqual(conversationKey('relay', 'group', 'shared'), conversationKey('relay', 'p2p', 'shared'));
  assert.notEqual(conversationKey('relay', 'group', 'a'), conversationKey('relay', 'group', 'b'));
  assert.notEqual(conversationKey('relay', 'group', 'shared'), conversationKey('xiaobei-dev', 'group', 'shared'));
});

test('one bot cannot be assigned different projects based on the chat channel', () => {
  assert.throws(() => indexBotProjects({ a: project({}), b: project({}) }), /each bot must represent one project/);
});

test('only a mention of this bot triggers a group response', () => {
  const identity = { openId: 'this-bot', userId: 'bot-user' };
  assert.equal(isBotMentioned({ content: '请帮我分析？', mentions: [] }, identity), false);
  assert.equal(isBotMentioned({ content: '/reset', mentionedBot: false, mentions: [{ openId: 'someone-else' }] }, identity), false);
  assert.equal(isBotMentioned({ mentionAll: true, mentions: [] }, identity), false);
  assert.equal(isBotMentioned({ mentions: [{ openId: 'other-bot', isBot: true }] }, identity), false);
  assert.equal(isBotMentioned({ mentions: [{ openId: 'this-bot' }] }, identity), true);
  assert.equal(isBotMentioned({ mentions: [{ userId: 'bot-user' }] }, identity), true);
  assert.equal(isBotMentioned({ mentionedBot: true }, identity), true);
});

test('group batches survive restart and keep new arrivals in the next batch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-group-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'messages.json');
  const record = (id, content) => groupMessageRecord({ messageId: id, senderId: 'sender', content, createTime: 1000 });
  const buffer = new GroupMessageBuffer(file);
  buffer.append('group-a', record('a', '第一条'));
  buffer.append('group-a', record('b', '第二条'));
  buffer.append('group-a', record('b', '第二条'));
  buffer.append('group-b', record('c', '另一个群'));
  const restored = new GroupMessageBuffer(file);
  const batch = restored.take('group-a');
  assert.deepEqual(batch.map((item) => item.messageId), ['a', 'b']);
  restored.append('group-a', record('d', '处理期间到达'));
  assert.equal(restored.count('group-a'), 1);
  assert.equal(restored.count('group-b'), 1);
  restored.restore('group-a', batch);
  assert.deepEqual(restored.take('group-a').map((item) => item.messageId), ['a', 'b', 'd']);
  assert.equal(new GroupMessageBuffer(file).count('group-a'), 0);
});

test('prompt includes sender identities, message order and attachment descriptions', () => {
  const first = groupMessageRecord({ messageId: '1', senderId: 'u1', senderName: '张三', content: '报警了', createTime: 1000 });
  const second = groupMessageRecord({ messageId: '2', senderId: 'u2', resources: [{ type: 'image', fileKey: 'image-key' }], createTime: 2000 });
  const current = groupMessageRecord({ messageId: '3', senderId: 'u3', content: '总结刚才的讨论', createTime: 3000 });
  const prompt = buildGroupPrompt([first, second], current);
  assert.match(prompt, /张三 \(u1\)/);
  assert.match(prompt, /u2:/);
  assert.match(prompt, /image-key/);
  assert.ok(prompt.indexOf('报警了') < prompt.indexOf('image-key'));
  assert.ok(prompt.indexOf('image-key') < prompt.indexOf('总结刚才的讨论'));
  assert.match(prompt, /【当前 @ 你的请求】/);
});

test('failed persistence cannot discard a batch taken for submission', () => {
  const buffer = new GroupMessageBuffer();
  buffer.append('group', groupMessageRecord({ messageId: '1', senderId: 'u1', content: '保留这条' }));
  buffer.save = () => { throw new Error('storage unavailable'); };
  assert.throws(() => buffer.take('group'), /storage unavailable/);
  assert.equal(buffer.count('group'), 1);
  assert.throws(() => buffer.clear('group'), /storage unavailable/);
  assert.equal(buffer.count('group'), 1);
});
