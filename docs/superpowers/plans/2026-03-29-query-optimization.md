# Query & Dedup Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halve database round-trips during extraction and eliminate full table scans on context/search queries by adding indexes and merging dedup queries.

**Architecture:** Three independent changes in two files: (1) 9 indexes added to `SCHEMA_SQL` and `migrate()` in `src/schema.js`, (2) 5 insert functions in `src/store.js` get their 2-read dedup merged into 1-read, (3) `getKnownMemberNames` in `src/store.js` gets a `LIMIT` parameter with input clamping.

**Tech Stack:** SQLite, FTS5, Node.js (CommonJS)

**Spec:** `docs/superpowers/specs/2026-03-29-query-optimization-design.md`

---

### Task 1: Add indexes to SCHEMA_SQL for fresh databases

**Files:**
- Modify: `src/schema.js:278-286` (just before the closing backtick of `SCHEMA_SQL`)

- [ ] **Step 1: Add index statements to SCHEMA_SQL**

In `src/schema.js`, insert these lines just before the closing backtick of `SCHEMA_SQL` (after the `embedding_metadata` table, before line 286's `` `; ``):

```js
-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_members_display_name ON members(display_name);
CREATE INDEX IF NOT EXISTS idx_facts_source_member ON facts(source_member_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source_member ON tasks(source_member_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at);
CREATE INDEX IF NOT EXISTS idx_topics_created_at ON topics(created_at);
CREATE INDEX IF NOT EXISTS idx_members_last_seen ON members(last_seen);
```

Note: `idx_members_last_seen` is added because `getKnownMemberNames` uses `ORDER BY last_seen DESC LIMIT 100`. The `username` index is omitted because the `UNIQUE` constraint already creates one.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: 238 passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/schema.js
git commit -m "perf: add indexes to SCHEMA_SQL for fresh databases"
```

---

### Task 2: Add indexes to migrate() for existing databases

**Files:**
- Modify: `src/schema.js:456-458` (end of `migrate()` function)

- [ ] **Step 1: Add index creation block at end of migrate()**

In `src/schema.js`, replace the final return in `migrate()` (line 458):

```js
  return { migrated: true, message: 'Migrated to v0.6 schema' };
```

with:

```js
  // Performance indexes (idempotent — safe on any v0.6+ database)
  const indexSql = `
    CREATE INDEX IF NOT EXISTS idx_members_display_name ON members(display_name);
    CREATE INDEX IF NOT EXISTS idx_facts_source_member ON facts(source_member_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_source_member ON tasks(source_member_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at);
    CREATE INDEX IF NOT EXISTS idx_topics_created_at ON topics(created_at);
    CREATE INDEX IF NOT EXISTS idx_members_last_seen ON members(last_seen);
  `;
  for (const stmt of indexSql.split(';').map(s => s.trim()).filter(Boolean)) {
    driver.write(stmt + ';');
  }

  return { migrated: true, message: 'Migrated to v0.6 schema' };
```

Also add the same index block for existing v0.6 databases that hit the early return. Replace line 325:

```js
  if (version >= '0.6') return { migrated: false, message: 'Already at v0.6' };
```

with:

```js
  if (version >= '0.6') {
    // Ensure performance indexes exist (added post-v0.6, idempotent)
    const indexSql = `
      CREATE INDEX IF NOT EXISTS idx_members_display_name ON members(display_name);
      CREATE INDEX IF NOT EXISTS idx_facts_source_member ON facts(source_member_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_source_member ON tasks(source_member_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at);
      CREATE INDEX IF NOT EXISTS idx_topics_created_at ON topics(created_at);
      CREATE INDEX IF NOT EXISTS idx_members_last_seen ON members(last_seen);
    `;
    for (const stmt of indexSql.split(';').map(s => s.trim()).filter(Boolean)) {
      driver.write(stmt + ';');
    }
    return { migrated: false, message: 'Already at v0.6' };
  }
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: 238 passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/schema.js
git commit -m "perf: add indexes to migrate() for existing databases"
```

---

### Task 3: Merge dedup queries in insertFact

**Files:**
- Modify: `src/store.js:62-84` (`insertFact` function)

- [ ] **Step 1: Replace two-read dedup with single combined query**

In `src/store.js`, replace the dedup block in `insertFact` (lines 67-84):

```js
  // 1. Exact prefix match (fast path)
  const prefix = esc(content.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM facts WHERE LOWER(SUBSTR(content, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  // 2. FTS similarity check: use first 2 distinctive keywords to find similar existing facts.
  //    Two keywords is enough to identify a topic ("langchain AND rag", "hetzner AND vps").
  //    Using more risks missing rephrased duplicates.
  const keywords = extractKeywords(content);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM facts WHERE id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${ftsQuery}') AND category = '${esc(fact.category)}' LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }
```

with:

```js
  // Dedup: combined exact-prefix + FTS keyword check in single query
  const prefix = esc(content.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(content);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM facts WHERE LOWER(SUBSTR(content, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR (id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${ftsQuery}') AND category = '${esc(fact.category)}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: 238 passed, 0 failed. The "exact dedup worked", "semantic dedup worked", and "Decision dedup: exact match blocked" tests confirm dedup still works.

- [ ] **Step 3: Commit**

```bash
git add src/store.js
git commit -m "perf: merge dedup queries in insertFact"
```

---

### Task 4: Merge dedup queries in insertDecision, insertTask, insertQuestion, insertEvent

**Files:**
- Modify: `src/store.js:147-162` (`insertDecision`)
- Modify: `src/store.js:179-194` (`insertTask`)
- Modify: `src/store.js:212-227` (`insertQuestion`)
- Modify: `src/store.js:244-261` (`insertEvent`)

- [ ] **Step 1: Replace two-read dedup in insertDecision (lines 149-162)**

Replace:

```js
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM decisions WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  const keywords = extractKeywords(description);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM decisions WHERE id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${ftsQuery}') LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }
```

with:

```js
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(description);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM decisions WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;
```

- [ ] **Step 2: Replace two-read dedup in insertTask (lines 181-194)**

Replace:

```js
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM tasks WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  const keywords = extractKeywords(description);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM tasks WHERE id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${ftsQuery}') LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }
```

with:

```js
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(description);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM tasks WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;
```

- [ ] **Step 3: Replace two-read dedup in insertQuestion (lines 214-227)**

Replace:

```js
  const prefix = esc(text.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM questions WHERE LOWER(SUBSTR(question, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  const keywords = extractKeywords(text);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM questions WHERE id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${ftsQuery}') LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }
```

with:

```js
  const prefix = esc(text.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(text);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM questions WHERE LOWER(SUBSTR(question, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;
```

- [ ] **Step 4: Replace two-read dedup in insertEvent (lines 248-261)**

Replace:

```js
  const prefix = esc(name.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM events WHERE LOWER(SUBSTR(name, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  const keywords = extractKeywords(name);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM events WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${ftsQuery}') LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }
```

with:

```js
  const prefix = esc(name.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(name);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM events WHERE LOWER(SUBSTR(name, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: 238 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/store.js
git commit -m "perf: merge dedup queries in insertDecision, insertTask, insertQuestion, insertEvent"
```

---

### Task 5: Cap getKnownMemberNames with LIMIT

**Files:**
- Modify: `src/store.js:526-529` (`getKnownMemberNames` function)

- [ ] **Step 1: Add limit parameter with input clamping**

In `src/store.js`, replace `getKnownMemberNames` (lines 526-529):

```js
function getKnownMemberNames(driver) {
  const rows = driver.read('SELECT display_name FROM members ORDER BY last_seen DESC');
  return rows.map(r => r.display_name).filter(Boolean);
}
```

with:

```js
function getKnownMemberNames(driver, limit = 100) {
  const safeLimit = Math.max(1, parseInt(limit) || 100);
  const rows = driver.read(`SELECT display_name FROM members ORDER BY last_seen DESC LIMIT ${safeLimit}`);
  return rows.map(r => r.display_name).filter(Boolean);
}
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: 238 passed, 0 failed

- [ ] **Step 3: Commit**

```bash
git add src/store.js
git commit -m "perf: cap getKnownMemberNames at 100 most recent members"
```
