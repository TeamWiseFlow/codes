import fs from 'node:fs';
import path from 'node:path';

// A bot represents one project. Chat type and chat ID select a conversation
// within that project, never a different project configuration.
export function indexBotProjects(projects) {
  const bots = new Map();
  for (const [alias, project] of Object.entries(projects)) {
    const { appId } = project.feishu;
    if (bots.has(appId)) {
      throw new Error(`Bot ${appId} is bound to both "${bots.get(appId).alias}" and "${alias}"; each bot must represent one project`);
    }
    bots.set(appId, { alias, project });
  }
  return bots;
}

export function conversationKey(alias, chatType, chatId) {
  return `${alias}:${chatType}:${chatId}`;
}

export function isBotMentioned(msg, identity) {
  if (msg.mentionedBot === true) return true;
  return (msg.mentions || []).some((mention) =>
    (identity?.openId && mention.openId === identity.openId)
    || (identity?.userId && mention.userId === identity.userId));
}

export function isOwnMessage(msg, identity) {
  return Boolean(identity?.openId && msg.senderId === identity.openId);
}

export function groupMessageRecord(msg) {
  const resources = (msg.resources || []).map((res) =>
    `[附件: ${res.fileName || res.type || 'attachment'}${res.fileKey ? `, key=${res.fileKey}` : ''}]`);
  return {
    messageId: msg.messageId,
    senderId: msg.senderId || 'unknown',
    senderName: msg.senderName || msg.senderId || 'unknown',
    createTime: msg.createTime || Date.now(),
    content: [String(msg.content || '').trim(), ...resources].filter(Boolean).join('\n')
      || `[${msg.rawContentType || '空消息'}]`,
  };
}

function formatRecord(record) {
  const sender = record.senderName === record.senderId
    ? record.senderId : `${record.senderName} (${record.senderId})`;
  return `${new Date(record.createTime).toISOString()} ${sender}:\n${record.content}`;
}

export function buildGroupPrompt(records, current) {
  return [
    '以下是本群自上次请求以来的聊天记录。聊天记录作为背景；请响应最后一条 @ 你的请求。',
    records.length ? `\n【群聊背景】\n${records.map(formatRecord).join('\n\n')}` : '',
    `\n【当前 @ 你的请求】\n${formatRecord(current)}`,
  ].filter(Boolean).join('\n');
}

// Persist each received message before any asynchronous work. Taking a batch
// is synchronous, so messages arriving during the AI turn belong to the next batch.
export class GroupMessageBuffer {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.messages = new Map();
    if (filePath && fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [key, records] of Object.entries(data)) {
        if (Array.isArray(records)) this.messages.set(key, records);
      }
    }
  }

  append(key, record) {
    const records = this.messages.get(key) || [];
    if (records.some((item) => item.messageId === record.messageId)) return;
    this.messages.set(key, [...records, record]);
    this.save();
  }

  take(key) {
    const records = this.messages.get(key) || [];
    this.messages.delete(key);
    try {
      this.save();
    } catch (e) {
      if (records.length) this.messages.set(key, records);
      throw e;
    }
    return records;
  }

  restore(key, records) {
    const merged = [...records, ...(this.messages.get(key) || [])];
    const seen = new Set();
    this.messages.set(key, merged.filter((record) => {
      if (seen.has(record.messageId)) return false;
      seen.add(record.messageId);
      return true;
    }));
    this.save();
  }

  clear(key) {
    const previous = this.messages.get(key);
    this.messages.delete(key);
    try {
      this.save();
    } catch (e) {
      if (previous) this.messages.set(key, previous);
      throw e;
    }
  }

  count(key) {
    return this.messages.get(key)?.length || 0;
  }

  prune(predicate) {
    const previous = this.messages;
    const next = new Map();
    let removed = 0;
    for (const [key, records] of previous) {
      const kept = records.filter((record) => !predicate(record));
      removed += records.length - kept.length;
      if (kept.length) next.set(key, kept);
    }
    if (!removed) return 0;
    this.messages = next;
    try { this.save(); }
    catch (error) { this.messages = previous; throw error; }
    return removed;
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify(Object.fromEntries(this.messages), null, 2), { mode: 0o600 });
    fs.renameSync(`${this.filePath}.tmp`, this.filePath);
  }
}
