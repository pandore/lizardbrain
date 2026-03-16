/**
 * store.js — Read/write extracted knowledge to memory.db.
 */

const db = require('./db');

function mergeCSV(existing, incoming) {
  const existingSet = new Set(
    (existing || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  const incomingItems = (incoming || '').split(',').map(s => s.trim()).filter(Boolean);
  const result = [...(existing || '').split(',').map(s => s.trim()).filter(Boolean)];

  for (const item of incomingItems) {
    if (!existingSet.has(item.toLowerCase())) {
      result.push(item);
      existingSet.add(item.toLowerCase());
    }
  }
  return result.join(', ');
}

function upsertMember(dbPath, member, messageDate) {
  const existing = db.read(dbPath,
    `SELECT id, expertise, projects FROM members WHERE display_name='${db.esc(member.display_name)}' OR username='${db.esc(member.username)}'`
  );

  if (existing.length > 0) {
    const e = existing[0];
    const mergedExpertise = mergeCSV(e.expertise, member.expertise);
    const mergedProjects = mergeCSV(e.projects, member.projects);

    db.write(dbPath, `
      UPDATE members SET
        expertise = '${db.esc(mergedExpertise)}',
        projects = '${db.esc(mergedProjects)}',
        last_seen = '${db.esc(messageDate)}',
        updated_at = datetime('now')
      WHERE id = ${e.id};
    `);
    return e.id;
  } else {
    db.write(dbPath, `
      INSERT INTO members (username, display_name, expertise, projects, first_seen, last_seen)
      VALUES (
        '${db.esc(member.username || '')}',
        '${db.esc(member.display_name)}',
        '${db.esc(member.expertise || '')}',
        '${db.esc(member.projects || '')}',
        '${db.esc(messageDate)}',
        '${db.esc(messageDate)}'
      );
    `);
    // Query back the id (last_insert_rowid doesn't work across separate sqlite3 processes)
    const inserted = db.read(dbPath,
      `SELECT id FROM members WHERE display_name='${db.esc(member.display_name)}' OR username='${db.esc(member.username)}'`
    );
    return inserted[0]?.id;
  }
}

function insertFact(dbPath, fact, memberId, messageDate) {
  const prefix = db.esc((fact.content || '').substring(0, 100).toLowerCase());
  const memberClause = memberId ? `source_member_id = ${memberId}` : 'source_member_id IS NULL';
  const existing = db.read(dbPath,
    `SELECT id FROM facts WHERE LOWER(SUBSTR(content, 1, 100)) = '${prefix}' AND ${memberClause} AND message_date = '${db.esc(messageDate)}'`
  );

  if (existing.length > 0) return false;

  db.write(dbPath, `
    INSERT INTO facts (category, content, source_member_id, tags, confidence, message_date)
    VALUES (
      '${db.esc(fact.category)}',
      '${db.esc(fact.content)}',
      ${memberId || 'NULL'},
      '${db.esc(fact.tags || '')}',
      ${parseFloat(fact.confidence) || 0.8},
      '${db.esc(messageDate)}'
    );
  `);
  return true;
}

function insertTopic(dbPath, topic, messageDate) {
  db.write(dbPath, `
    INSERT INTO topics (name, summary, participants, message_date, tags)
    VALUES (
      '${db.esc(topic.name)}',
      '${db.esc(topic.summary || '')}',
      '${db.esc(topic.participants || '')}',
      '${db.esc(messageDate)}',
      '${db.esc(topic.tags || '')}'
    );
  `);
  return true;
}

function processExtraction(dbPath, extracted, messageDate) {
  let totalFacts = 0, totalTopics = 0, totalMembers = 0;
  const memberIdMap = {};

  if (extracted.members && Array.isArray(extracted.members)) {
    for (const member of extracted.members) {
      if (!member.display_name) continue;
      const id = upsertMember(dbPath, member, messageDate);
      memberIdMap[member.display_name.toLowerCase()] = id;
      totalMembers++;
    }
  }

  if (extracted.facts && Array.isArray(extracted.facts)) {
    for (const fact of extracted.facts) {
      if (!fact.content) continue;
      const memberId = fact.source_member
        ? memberIdMap[fact.source_member.toLowerCase()] || null
        : null;
      if (insertFact(dbPath, fact, memberId, messageDate)) {
        totalFacts++;
      }
    }
  }

  if (extracted.topics && Array.isArray(extracted.topics)) {
    for (const topic of extracted.topics) {
      if (!topic.name) continue;
      insertTopic(dbPath, topic, messageDate);
      totalTopics++;
    }
  }

  return { totalFacts, totalTopics, totalMembers };
}

function getState(dbPath) {
  const rows = db.read(dbPath, 'SELECT * FROM extraction_state WHERE id=1');
  return rows[0] || null;
}

function updateState(dbPath, { lastProcessedId, messagesProcessed, factsExtracted, topicsExtracted }) {
  db.write(dbPath, `
    UPDATE extraction_state SET
      last_processed_id = '${db.esc(String(lastProcessedId))}',
      total_messages_processed = total_messages_processed + ${messagesProcessed},
      total_facts_extracted = total_facts_extracted + ${factsExtracted},
      total_topics_extracted = total_topics_extracted + ${topicsExtracted},
      total_members_seen = (SELECT COUNT(*) FROM members),
      last_run_at = datetime('now')
    WHERE id = 1;
  `);
}

function resetState(dbPath) {
  db.write(dbPath, "UPDATE extraction_state SET last_processed_id = '0', total_messages_processed = 0 WHERE id = 1;");
}

function getStats(dbPath) {
  const members = db.read(dbPath, 'SELECT COUNT(*) as c FROM members');
  const facts = db.read(dbPath, 'SELECT COUNT(*) as c FROM facts');
  const topics = db.read(dbPath, 'SELECT COUNT(*) as c FROM topics');
  const state = getState(dbPath);

  return {
    members: parseInt(members[0]?.c) || 0,
    facts: parseInt(facts[0]?.c) || 0,
    topics: parseInt(topics[0]?.c) || 0,
    messagesProcessed: parseInt(state?.total_messages_processed) || 0,
    lastProcessedId: state?.last_processed_id || '0',
    lastRun: state?.last_run_at || 'never',
  };
}

// --- Query helpers ---

function searchFacts(dbPath, query, limit = 10) {
  return db.read(dbPath,
    `SELECT f.*, m.display_name as source FROM facts f LEFT JOIN members m ON f.source_member_id = m.id WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${db.esc(query)}') ORDER BY f.created_at DESC LIMIT ${limit}`
  );
}

function searchTopics(dbPath, query, limit = 10) {
  return db.read(dbPath,
    `SELECT * FROM topics WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${db.esc(query)}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function searchMembers(dbPath, query) {
  return db.read(dbPath,
    `SELECT * FROM members WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${db.esc(query)}')`
  );
}

function whoKnows(dbPath, keyword) {
  return db.read(dbPath,
    `SELECT display_name, username, expertise, projects FROM members WHERE expertise LIKE '%${db.esc(keyword)}%' OR projects LIKE '%${db.esc(keyword)}%' ORDER BY last_seen DESC`
  );
}

module.exports = {
  processExtraction,
  getState,
  updateState,
  resetState,
  getStats,
  searchFacts,
  searchTopics,
  searchMembers,
  whoKnows,
};
