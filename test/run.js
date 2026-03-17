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

  // Dedup: insert same fact again (exact match)
  store.processExtraction(MEMORY_DB, {
    members: [{ display_name: 'Alice', username: 'alice', expertise: 'RAG, Python', projects: 'pipeline, new-project' }],
    facts: [{ category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag', confidence: 0.9 }],
    topics: [],
  }, '2026-03-15');

  const stats2 = store.getStats(MEMORY_DB);
  assert(stats2.members === 2, `Still ${stats2.members} members after upsert (expected 2)`);
  assert(stats2.facts === 2, `Still ${stats2.facts} facts — exact dedup worked (expected 2)`);

  // Dedup: insert semantically similar fact (LLM rephrased it)
  store.processExtraction(MEMORY_DB, {
    members: [],
    facts: [{ category: 'tool', content: 'LangChain is effective for RAG pipelines, especially with a chunk size of 512 tokens', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 }],
    topics: [{ name: 'Comparing RAG Pipeline Tools', summary: 'LangChain vs LlamaIndex comparison', participants: 'Alice, Bob', tags: 'rag' }],
  }, '2026-03-15');

  const stats3 = store.getStats(MEMORY_DB);
  assert(stats3.facts === 2, `Still ${stats3.facts} facts — semantic dedup worked (expected 2)`);
  assert(stats3.topics === 1, `Still ${stats3.topics} topics — topic dedup worked (expected 1)`);

  // Check member expertise was merged
  const alice = store.searchMembers(MEMORY_DB, 'Alice');
  assert(alice.length > 0 && alice[0].expertise.includes('Python'), 'Alice expertise merged with Python');
  assert(alice.length > 0 && alice[0].projects.includes('new-project'), 'Alice projects merged');
}

function testConfidenceFiltering() {
  console.log('\n--- Test: confidence filtering ---');

  // Insert facts with different confidence levels
  store.processExtraction(MEMORY_DB, {
    members: [],
    facts: [
      { category: 'tool', content: 'High confidence fact about Docker pricing at $5/month', source_member: 'alice', tags: 'docker, pricing', confidence: 0.95 },
      { category: 'opinion', content: 'Medium confidence opinion about Kubernetes being overkill', source_member: 'bob', tags: 'kubernetes, opinion', confidence: 0.8 },
      { category: 'tool', content: 'Low confidence rumor about a new AWS service', source_member: 'alice', tags: 'aws, rumor', confidence: 0.5 },
    ],
    topics: [],
  }, '2026-03-16');

  // Search without filter
  const allFacts = store.searchFacts(MEMORY_DB, 'Docker OR Kubernetes OR AWS');
  assert(allFacts.length >= 3, `Found ${allFacts.length} facts without filter (expected >= 3)`);

  // Search with minConfidence 0.75
  const highFacts = store.searchFacts(MEMORY_DB, 'Docker OR Kubernetes OR AWS', 15, 0.75);
  assert(highFacts.length >= 2, `Found ${highFacts.length} facts with confidence >= 0.75 (expected >= 2)`);

  // Search with minConfidence 0.9
  const veryHigh = store.searchFacts(MEMORY_DB, 'Docker OR Kubernetes OR AWS', 15, 0.9);
  assert(veryHigh.length >= 1, `Found ${veryHigh.length} facts with confidence >= 0.9 (expected >= 1)`);

  // Verify ordering: high confidence first
  if (highFacts.length >= 2) {
    assert(parseFloat(highFacts[0].confidence) >= parseFloat(highFacts[1].confidence),
      'Facts ordered by confidence descending');
  }
}

function testRoster() {
  console.log('\n--- Test: roster generation ---');

  const roster = store.generateRoster(MEMORY_DB);
  assert(roster.count >= 2, `Roster has ${roster.count} members (expected >= 2)`);
  assert(roster.content.startsWith('# Community Members'), 'Roster starts with header');
  assert(roster.content.includes('Alice'), 'Roster contains Alice');
  assert(roster.content.includes('Bob'), 'Roster contains Bob');
  assert(roster.content.includes('RAG'), 'Roster includes expertise');
}

function testConversationFilter() {
  console.log('\n--- Test: conversation filtering ---');

  // Create a source with mixed group/DM conversations
  const CONV_DB = path.join(TEST_DIR, 'conv-source.db');
  execSync(`sqlite3 "${CONV_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      -- Group messages (with is_group_chat marker)
      INSERT INTO messages VALUES (1, 1, 'Alice', 'Group msg with "is_group_chat": true marker about Python', '2026-03-15');
      INSERT INTO messages VALUES (2, 1, 'Bob', 'Another group msg "is_group_chat": true about RAG', '2026-03-15');
      INSERT INTO messages VALUES (3, 1, 'Alice', 'Third group "is_group_chat": true message', '2026-03-15');
      -- DM messages (no marker)
      INSERT INTO messages VALUES (4, 2, 'Alice', 'Private DM message about secrets', '2026-03-15');
      INSERT INTO messages VALUES (5, 2, 'Alice', 'Another private DM', '2026-03-15');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const adapter = chatmem.adapters.sqlite.create({
    path: CONV_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
    conversationFilter: {
      column: 'conversation_id',
      detectGroup: { contentColumn: 'content', marker: 'is_group_chat' },
    },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter with conversation filter validates');
  assert(validation.groupConversations?.length === 1, `Detected ${validation.groupConversations?.length} group conversation(s) (expected 1)`);

  const messages = adapter.getMessages('0');
  assert(messages.length === 3, `Got ${messages.length} messages (expected 3 — group only, no DMs)`);
  assert(!messages.some(m => m.content.includes('secrets')), 'DM content excluded');
}

async function testUrlEnrichment() {
  console.log('\n--- Test: URL enrichment ---');

  const urlEnricher = require('../src/enrichers/url');

  // Test with a known GitHub repo
  const messages = [
    { id: '1', content: 'Check out https://github.com/pandore/clawmem for memory extraction', sender: 'Alice', timestamp: '2026-03-17' },
    { id: '2', content: 'No URLs in this message', sender: 'Bob', timestamp: '2026-03-17' },
    { id: '3', content: 'Multiple URLs: https://github.com/pandore/clawmem and https://example.com', sender: 'Alice', timestamp: '2026-03-17' },
  ];

  const result = await urlEnricher.enrichMessages(messages, { timeoutMs: 10000 });
  assert(result.enriched >= 1, `Enriched ${result.enriched} URLs (expected >= 1)`);

  // GitHub URL should have been enriched with repo info
  const msg1 = messages[0].content;
  assert(msg1.includes('[') && msg1.includes('clawmem'), `GitHub URL enriched: ${msg1.substring(0, 120)}...`);

  // Message without URLs should be unchanged
  assert(messages[1].content === 'No URLs in this message', 'Non-URL message unchanged');

  // Test with empty messages
  const emptyResult = await urlEnricher.enrichMessages([]);
  assert(emptyResult.enriched === 0, 'Empty messages returns 0 enriched');
}

// --- Run ---

async function runAll() {
  setup();
  testInit();
  testAdapter();
  testJsonlAdapter();
  testStore();
  testConfidenceFiltering();
  testRoster();
  testConversationFilter();
  await testUrlEnrichment();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error(`\nTest crashed: ${err.message}\n${err.stack}`);
  cleanup();
  process.exit(1);
});
