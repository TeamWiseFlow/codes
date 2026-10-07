import fs from 'node:fs';
import path from 'node:path';

// Message IDs are shared across bot apps, unlike their sender open_ids.
// Remember bridge-generated notices so every bot can ignore the same message.
export class BridgeNoticeRegistry {
  constructor(filePath = null, { maxEntries = 4096 } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.ids = new Set(filePath && fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf8')).slice(-maxEntries) : []);
    this.pending = new Map();
  }

  has(messageId) {
    return this.ids.has(messageId);
  }

  remember(messageId) {
    if (!messageId || this.ids.has(messageId)) return;
    this.ids.add(messageId);
    while (this.ids.size > this.maxEntries) this.ids.delete(this.ids.values().next().value);
    // A journal failure must not turn a successful Feishu send into a retry.
    try {
      if (!this.filePath) return;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify([...this.ids]), { mode: 0o600 });
      fs.renameSync(`${this.filePath}.tmp`, this.filePath);
    } catch (error) {
      console.warn('[WARN] bridge notice registry persistence:', error.message);
    }
  }

  key(chatId, text) {
    return JSON.stringify([chatId, String(text || '').trim()]);
  }

  isNotice(msg) {
    if (this.has(msg.messageId)) return true;
    const senderType = msg.senderType || msg.raw?.sender?.sender_type;
    // WebSocket delivery can precede the send response. Match only the exact
    // notice currently being sent, in this chat, and only from an app.
    if (senderType !== 'app' || !this.pending.has(this.key(msg.chatId, msg.content))) return false;
    this.remember(msg.messageId);
    return true;
  }

  async send(chatId, texts, send) {
    const keys = [...new Set((Array.isArray(texts) ? texts : [texts])
      .map((text) => this.key(chatId, text)))];
    for (const key of keys) this.pending.set(key, (this.pending.get(key) || 0) + 1);
    try {
      const result = await send();
      for (const id of [result?.messageId, result?.data?.message_id, ...(result?.chunkIds || [])]) {
        this.remember(id);
      }
      return result;
    } finally {
      for (const key of keys) {
        const remaining = this.pending.get(key) - 1;
        if (remaining) this.pending.set(key, remaining);
        else this.pending.delete(key);
      }
    }
  }
}
