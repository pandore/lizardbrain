# chatmem

Lightweight structured memory extraction for community chats. Reads messages from any source, extracts knowledge (members, facts, topics) via any LLM, stores in a searchable SQLite database with full-text search.

**Zero dependencies.** Uses Node.js built-in modules and the system `sqlite3` CLI.

## Why

Community chats generate valuable knowledge that gets buried in scroll. chatmem runs as a background job, reads new messages, and builds a structured knowledge base that can be queried by humans or AI agents.

## How It Works

```
[Chat Source] → [Adapter] → [LLM Extraction] → [SQLite + FTS5]
     ↑                            ↑                    ↑
  Any SQLite DB          Any OpenAI-compatible     Searchable with
  JSONL file             API (OpenAI, Gemini,      full-text search
  Custom adapter         Ollama, Groq, etc.)
```

Messages are batched and sent to an LLM that extracts:
- **Members** — who's in the chat, their expertise, projects
- **Facts** — tools, techniques, opinions, resources mentioned
- **Topics** — discussion threads with summaries and participants

Everything is stored in SQLite with FTS5 indexes for fast search.

## Quick Start

```bash
# Prerequisites: Node.js >= 18, sqlite3 CLI
git clone https://github.com/pandore/chatmem
cd chatmem

# Create config
cp examples/chatmem.json chatmem.json
# Edit chatmem.json — set your source DB path and LLM settings

# Initialize memory database
node src/cli.js init

# Run extraction
CHATMEM_LLM_API_KEY=your-key node src/cli.js extract

# Check results
node src/cli.js stats
node src/cli.js search "machine learning"
node src/cli.js who "python"
```

## Configuration

Create a `chatmem.json` in your working directory:

```json
{
  "memoryDbPath": "./chatmem.db",
  "batchSize": 40,
  "minMessages": 5,

  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },

  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": {
      "id": "id",
      "content": "content",
      "sender": "sender_name",
      "timestamp": "created_at"
    },
    "filter": "role = 'user'"
  }
}
```

### LLM Providers

chatmem works with any OpenAI-compatible API:

| Provider | `baseUrl` | `model` |
|----------|-----------|---------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama | `http://localhost:11434/v1` | `llama3.2` |
| LM Studio | `http://localhost:1234/v1` | `local-model` |

API key can be set via config, environment variable (`CHATMEM_LLM_API_KEY`), or `.env` file.

### Source Adapters

#### SQLite (default)

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": {
      "id": "message_id",
      "content": "text",
      "sender": "author",
      "timestamp": "created_at"
    },
    "filter": "channel = 'general'"
  }
}
```

#### JSONL

```json
{
  "source": {
    "type": "jsonl",
    "path": "./messages.jsonl",
    "fields": {
      "id": "id",
      "content": "text",
      "sender": "from",
      "timestamp": "date"
    }
  }
}
```

Each line: `{"id": "1", "from": "Alice", "text": "Hello!", "date": "2026-01-01"}`

#### Custom Adapter

```json
{
  "source": {
    "type": "custom",
    "adapterPath": "./my-adapter.js"
  }
}
```

Your adapter exports:

```js
module.exports = {
  name: 'my-source',
  validate() { return { ok: true }; },
  getMessages(afterId) {
    // Return array of { id, content, sender, timestamp }
    return [...];
  }
};
```

## CLI

```
chatmem init [--force]                    Create memory database
chatmem extract [--dry-run] [--reprocess] Run extraction pipeline
chatmem stats                             Show database statistics
chatmem search <query>                    Full-text search facts and topics
chatmem who <keyword>                     Find members by expertise
```

## Programmatic API

```js
const chatmem = require('chatmem');

// Initialize
chatmem.init('./memory.db');

// Create adapter
const adapter = chatmem.adapters.sqlite.create({
  path: './chat.db',
  table: 'messages',
  columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
});

// Extract
await chatmem.extract(adapter, './memory.db', {
  batchSize: 40,
  minMessages: 5,
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
  },
});

// Query
const facts = chatmem.query.searchFacts('./memory.db', 'kubernetes');
const experts = chatmem.query.whoKnows('./memory.db', 'python');
const topics = chatmem.query.searchTopics('./memory.db', 'deployment');
const stats = chatmem.query.getStats('./memory.db');
```

## Cron Setup

Run extraction every 15 minutes:

```bash
*/15 * * * * cd /path/to/project && CHATMEM_LLM_API_KEY=key node src/cli.js extract >> /tmp/chatmem.log 2>&1
```

## Schema

chatmem creates these tables:

- `members` — username, display_name, expertise, projects, first/last seen
- `facts` — category, content, source member, tags, confidence, date
- `topics` — name, summary, participants, tags, date
- `extraction_state` — cursor position, counters
- `*_fts` — FTS5 full-text search indexes (auto-synced via triggers)

Query directly with sqlite3:

```bash
# Search facts
sqlite3 -json chatmem.db "SELECT * FROM facts_fts WHERE facts_fts MATCH 'docker'"

# Find experts
sqlite3 -json chatmem.db "SELECT display_name, expertise FROM members WHERE expertise LIKE '%python%'"

# Recent topics
sqlite3 -json chatmem.db "SELECT name, summary FROM topics ORDER BY created_at DESC LIMIT 10"
```

## Requirements

- Node.js >= 18 (uses built-in `fetch`)
- `sqlite3` CLI with FTS5 support (standard on macOS and most Linux)

## License

MIT
