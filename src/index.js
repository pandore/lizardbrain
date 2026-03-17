/**
 * clawmem — Lightweight structured memory extraction for community chats.
 *
 * Usage (programmatic):
 *
 *   const clawmem = require('clawmem');
 *
 *   // Initialize database
 *   clawmem.init('./my-memory.db');
 *
 *   // Create a source adapter
 *   const adapter = clawmem.adapters.sqlite.create({
 *     path: './chat.db',
 *     table: 'messages',
 *     columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
 *   });
 *
 *   // Run extraction
 *   await clawmem.extract(adapter, './my-memory.db', {
 *     llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...', model: 'gpt-4o-mini' },
 *   });
 *
 *   // Query
 *   clawmem.query.searchFacts('./my-memory.db', 'machine learning');
 *   clawmem.query.whoKnows('./my-memory.db', 'python');
 */

const schema = require('./schema');
const extractor = require('./extractor');
const store = require('./store');
const config = require('./config');
const sqliteAdapter = require('./adapters/sqlite');
const jsonlAdapter = require('./adapters/jsonl');

module.exports = {
  // Schema
  init: schema.init,

  // Extraction
  extract: extractor.run,

  // Config
  loadConfig: config.load,

  // Query helpers
  query: {
    searchFacts: store.searchFacts,
    searchTopics: store.searchTopics,
    searchMembers: store.searchMembers,
    whoKnows: store.whoKnows,
    getStats: store.getStats,
    generateRoster: store.generateRoster,
  },

  // Adapters
  adapters: {
    sqlite: sqliteAdapter,
    jsonl: jsonlAdapter,
  },
};
