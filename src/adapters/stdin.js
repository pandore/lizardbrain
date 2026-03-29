/**
 * stdin.js — Reads JSONL messages from stdin.
 *
 * Usage:
 *   cat messages.jsonl | lizardbrain extract --source stdin
 *   curl https://api.example.com/messages | lizardbrain extract --source stdin
 *
 * Configuration:
 *   {
 *     type: 'stdin',
 *     fields: {
 *       id: 'id',
 *       content: 'content',
 *       sender: 'sender',
 *       timestamp: 'timestamp',
 *       conversationId: 'conversation_id',
 *     }
 *   }
 *
 * Each line of stdin should be a JSON object. Lines that fail to parse are skipped.
 * The adapter buffers all stdin before getMessages() is called.
 */

const fs = require('fs');

function create(config = {}) {
  const { fields = {} } = config;

  const idField = fields.id || 'id';
  const contentField = fields.content || 'content';
  const senderField = fields.sender || 'sender';
  const timestampField = fields.timestamp || 'timestamp';
  const conversationField = fields.conversationId || fields.conversation || null;

  let _buffer = null;

  function readStdin() {
    if (_buffer !== null) return _buffer;
    try {
      _buffer = fs.readFileSync(0, 'utf-8'); // fd 0 = stdin, cross-platform
    } catch (err) {
      _buffer = '';
      console.error(`[lizardbrain:stdin] Read error: ${err.message}`);
    }
    return _buffer;
  }

  return {
    name: 'stdin',

    validate() {
      const raw = readStdin();
      if (!raw || raw.trim().length === 0) {
        return { ok: false, error: 'No data on stdin. Pipe JSONL messages, e.g.: cat messages.jsonl | lizardbrain extract --source stdin' };
      }
      return { ok: true };
    },

    getMessages(afterId) {
      const raw = readStdin();
      const lines = raw.split('\n').filter(l => l.trim());
      const afterIdStr = String(afterId);

      let pastCursor = afterIdStr === '0';
      const messages = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const id = String(obj[idField] || '');

          if (!pastCursor) {
            if (id === afterIdStr) pastCursor = true;
            continue;
          }

          messages.push({
            id,
            content: obj[contentField] || '',
            sender: obj[senderField] || 'unknown',
            timestamp: obj[timestampField] || '',
            conversationId: conversationField ? (obj[conversationField] || null) : null,
          });
        } catch {}
      }

      return messages.filter(m => m.content.length > 0);
    },

    describe() {
      const raw = readStdin();
      const lineCount = raw ? raw.split('\n').filter(l => l.trim()).length : 0;
      return {
        source: 'stdin',
        format: 'jsonl',
        lines: lineCount,
        mapping: { id: idField, content: contentField, sender: senderField, timestamp: timestampField },
      };
    },
  };
}

module.exports = { create };
