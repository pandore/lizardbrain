#!/usr/bin/env node
/**
 * Basic integration test for chatmem.
 * Creates a test SQLite source, runs extraction with a mock LLM, verifies results.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const chatmem = require('../src/index');
const store = require('../src/store');

const TEST_DIR = path.join(__dirname, '.test-data');
const SOURCE_DB = path.join(TEST_DIR, 'source.db');
const MEMORY_DB = path.join(TEST_DIR, 'memory.db');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Create source database with test messages
  execSync(`sqlite3 "${SOURCE_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      INSERT INTO messages VALUES (1, 'Alice', 'I have been using LangChain for our RAG pipeline, works great with chunk size 512', '2026-03-15T10:00:00Z');
      INSERT INTO messages VALUES (2, 'Bob', 'We switched to LlamaIndex last month, much better for large PDFs', '2026-03-15T10:05:00Z');
      INSERT INTO messages VALUES (3, 'Alice', 'Interesting! What embedding model are you using?', '2026-03-15T10:10:00Z');
      INSERT INTO messages VALUES (4, 'Bob', 'text-embedding-3-small from OpenAI, cheap and decent quality', '2026-03-15T10:15:00Z');
      INSERT INTO messages VALUES (5, 'Charlie', 'Has anyone tried Claude Code for refactoring? I use it daily on our Python backend', '2026-03-15T10:20:00Z');
      INSERT INTO messages VALUES (6, 'Alice', 'Claude Code is amazing for large refactors, saved us hours last week', '2026-03-15T10:25:00Z');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

// --- Tests ---

function testInit() {
  console.log('\n--- Test: init ---');

  const result = chatmem.init(MEMORY_DB);
  assert(result.created === true, 'Database created');
  assert(fs.existsSync(MEMORY_DB), 'File exists on disk');

  // Verify schema
  const tables = execSync(`sqlite3 "${MEMORY_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('members'), 'members table exists');
  assert(tables.includes('facts'), 'facts table exists');
  assert(tables.includes('topics'), 'topics table exists');
  assert(tables.includes('facts_fts'), 'FTS tables exist');
  assert(tables.includes('extraction_state'), 'extraction_state table exists');

  // Idempotent
  const result2 = chatmem.init(MEMORY_DB);
  assert(result2.created === false, 'Second init skips creation');
}

function testAdapter() {
  console.log('\n--- Test: sqlite adapter ---');

  const adapter = chatmem.adapters.sqlite.create({
    path: SOURCE_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter validates successfully');

  const messages = adapter.getMessages('0');
  assert(messages.length === 6, `Got ${messages.length} messages (expected 6)`);
  assert(messages[0].sender === 'Alice', 'First message sender is Alice');
  assert(messages[0].content.includes('LangChain'), 'First message content is correct');

  // Cursor works
  const after3 = adapter.getMessages('3');
  assert(after3.length === 3, `Got ${after3.length} messages after id 3 (expected 3)`);
}

function testJsonlAdapter() {
  console.log('\n--- Test: jsonl adapter ---');

  const jsonlPath = path.join(TEST_DIR, 'messages.jsonl');
  const lines = [
    '{"id":"1","sender":"Alice","content":"Hello world","timestamp":"2026-01-01"}',
    '{"id":"2","sender":"Bob","content":"Testing JSONL adapter","timestamp":"2026-01-02"}',
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n'));

  const adapter = chatmem.adapters.jsonl.create({ path: jsonlPath });
  const validation = adapter.validate();
  assert(validation.ok === true, 'JSONL adapter validates');

  const messages = adapter.getMessages('0');
  assert(messages.length === 2, `Got ${messages.length} messages (expected 2)`);
  assert(messages[0].sender === 'Alice', 'First message sender correct');
}

function testStore() {
  console.log('\n--- Test: store operations ---');

  // Direct store operations (simulating what extraction does)
  store.processExtraction(MEMORY_DB, {
    members: [
      { display_name: 'Alice', username: 'alice', expertise: 'RAG, LangChain', projects: 'pipeline' },
      { display_name: 'Bob', username: 'bob', expertise: 'LlamaIndex, embeddings', projects: '' },
    ],
    facts: [
      { category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 },
      { category: 'opinion', content: 'LlamaIndex is better for large PDFs than LangChain', source_member: 'bob', tags: 'rag, llamaindex', confidence: 0.8 },
    ],
    topics: [
      { name: 'RAG Pipeline Comparison', summary: 'Discussion comparing LangChain vs LlamaIndex for RAG', participants: 'Alice, Bob', tags: 'rag, comparison' },
    ],
  }, '2026-03-15');

  const stats = store.getStats(MEMORY_DB);
  assert(stats.members === 2, `${stats.members} members (expected 2)`);
  assert(stats.facts === 2, `${stats.facts} facts (expected 2)`);
  assert(stats.topics === 1, `${stats.topics} topics (expected 1)`);

  // FTS search
  const ragFacts = store.searchFacts(MEMORY_DB, 'RAG');
  assert(ragFacts.length === 2, `FTS found ${ragFacts.length} RAG facts (expected 2)`);

  const ragTopics = store.searchTopics(MEMORY_DB, 'RAG');
  assert(ragTopics.length === 1, `FTS found ${ragTopics.length} RAG topics (expected 1)`);

  // Who knows
  const ragExperts = store.whoKnows(MEMORY_DB, 'RAG');
  assert(ragExperts.length === 1, `Found ${ragExperts.length} RAG experts (expected 1)`);

  // Dedup: insert same fact again
  store.processExtraction(MEMORY_DB, {
    members: [{ display_name: 'Alice', username: 'alice', expertise: 'RAG, Python', projects: 'pipeline, new-project' }],
    facts: [{ category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag', confidence: 0.9 }],
    topics: [],
  }, '2026-03-15');

  const stats2 = store.getStats(MEMORY_DB);
  assert(stats2.members === 2, `Still ${stats2.members} members after upsert (expected 2)`);
  assert(stats2.facts === 2, `Still ${stats2.facts} facts — dedup worked (expected 2)`);

  // Check member expertise was merged
  const alice = store.searchMembers(MEMORY_DB, 'Alice');
  assert(alice.length > 0 && alice[0].expertise.includes('Python'), 'Alice expertise merged with Python');
  assert(alice.length > 0 && alice[0].projects.includes('new-project'), 'Alice projects merged');
}

// --- Run ---

try {
  setup();
  testInit();
  testAdapter();
  testJsonlAdapter();
  testStore();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error(`\nTest crashed: ${err.message}\n${err.stack}`);
  cleanup();
  process.exit(1);
}
