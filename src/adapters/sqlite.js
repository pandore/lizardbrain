/**
 * sqlite.js — Generic SQLite adapter for reading messages from any SQLite database.
 *
 * Configuration:
 *   {
 *     path: '/path/to/chat.db',
 *     table: 'messages',
 *     columns: {
 *       id: 'message_id',        // unique message identifier (used for cursor)
 *       content: 'content',      // message text
 *       sender: 'sender_name',   // who sent it (optional if embedded in content)
 *       timestamp: 'created_at', // when (optional)
 *       role: 'role',            // filter column (optional)
 *     },
 *     filter: "role = 'user'",   // optional WHERE clause to filter messages
 *     contentParser: null,       // optional function(rawContent) => { sender, content, timestamp }
 *   }
 */

const db = require('../db');

function create(config) {
  const {
    path: dbPath,
    table = 'messages',
    columns = {},
    filter = null,
    contentParser = null,
  } = config;

  const idCol = columns.id || 'id';
  const contentCol = columns.content || 'content';
  const senderCol = columns.sender || null;
  const timestampCol = columns.timestamp || null;

  return {
    name: 'sqlite',

    validate() {
      if (!db.exists(dbPath)) {
        return { ok: false, error: `Database not found: ${dbPath}` };
      }

      const tables = db.read(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
      const tableNames = tables.map(t => t.name);

      if (!tableNames.includes(table)) {
        return { ok: false, error: `Table '${table}' not found. Available: ${tableNames.join(', ')}` };
      }

      return { ok: true };
    },

    getMessages(afterId) {
      let where = `${idCol} > '${db.esc(String(afterId))}'`;
      if (filter) where += ` AND (${filter})`;

      const selectCols = [idCol, contentCol];
      if (senderCol) selectCols.push(senderCol);
      if (timestampCol) selectCols.push(timestampCol);

      const query = `SELECT ${selectCols.join(', ')} FROM ${table} WHERE ${where} ORDER BY ${idCol} ASC`;
      const rows = db.read(dbPath, query);

      return rows.map(row => {
        if (contentParser) {
          const parsed = contentParser(row[contentCol] || '');
          return {
            id: row[idCol],
            content: parsed.content || row[contentCol],
            sender: parsed.sender || (senderCol ? row[senderCol] : 'unknown'),
            timestamp: parsed.timestamp || (timestampCol ? row[timestampCol] : ''),
          };
        }

        return {
          id: row[idCol],
          content: row[contentCol] || '',
          sender: senderCol ? (row[senderCol] || 'unknown') : 'unknown',
          timestamp: timestampCol ? (row[timestampCol] || '') : '',
        };
      }).filter(m => m.content && m.content.length > 0);
    },

    describe() {
      const cols = db.read(dbPath, `PRAGMA table_info(${table})`);
      return {
        path: dbPath,
        table,
        columns: cols.map(c => c.name),
        mapping: { id: idCol, content: contentCol, sender: senderCol, timestamp: timestampCol },
      };
    },
  };
}

module.exports = { create };
