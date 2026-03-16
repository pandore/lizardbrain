# clawmem

Lightweight structured memory for community chats. Reads messages from any source, extracts knowledge (members, facts, topics) via any LLM, stores in a searchable SQLite database with full-text search.

Born from the [OpenClaw](https://github.com/open-claw/openclaw) ecosystem — built to give AI agents persistent memory of group conversations. Works standalone with any chat source and any LLM provider.

**Zero dependencies.** Node.js built-in modules + system `sqlite3` CLI. Nothing to install.

## How It Works

```
[Chat Source] → [Adapter] → [LLM Extraction] → [SQLite + FTS5]
```

1. **Adapter** reads new messages from your chat database (SQLite, JSONL, or custom)
2. **LLM** extracts structured knowledge — members, facts, topics — via any OpenAI-compatible API
3. **SQLite + FTS5** stores everything with full-text search, auto-synced indexes, and deduplication

Runs incrementally: tracks a cursor, only processes new messages each run. Designed to run on a cron every 15 minutes.

## Quick Start

```bash
# Clone
git clone https://github.com/pandore/clawmem
cd clawmem

# Create config
cp examples/clawmem.json clawmem.json
# Edit clawmem.json — point to your chat DB and LLM

# Initialize memory database
node src/cli.js init

# Run extraction
CLAWMEM_LLM_API_KEY=your-key node src/cli.js extract

# Query
node src/cli.js stats
node src/cli.js search "RAG pipeline"
node src/cli.js who "python"
```

## Configuration

Create `clawmem.json` in your working directory:

```json
{
  "memoryDbPath": "./clawmem.db",
  "batchSize": 40,
  "minMessages": 5,

  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5-nano"
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

API key goes in `.env`, environment variable (`CLAWMEM_LLM_API_KEY`), or directly in config.

### LLM Providers

clawmem works with any OpenAI-compatible chat completions API. Pick whatever fits your budget:

| Provider | `baseUrl` | Recommended model | Cost (per 1M tokens) |
|----------|-----------|-------------------|----------------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-5-nano` | $0.05 / $0.40 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash-lite` | $0.10 / $0.40 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-instruct` | $0.10 / $0.32 |
| Mistral | `https://api.mistral.ai/v1` | `ministral-3b-2512` | $0.10 / $0.10 |
| Anthropic | `https://api.anthropic.com/v1/` | `claude-haiku-4.5` | $1.00 / $5.00 |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` | free (local) |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-4-scout` | $0.08 / $0.30 |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.1-8B-Instruct-Turbo` | ~$0.05 |
| LM Studio | `http://localhost:1234/v1` | any local model | free (local) |

For extraction tasks, cheap/fast models work great. You don't need a frontier model to pull facts out of chat messages.

### Source Adapters

#### SQLite (default)

Point at any SQLite database with a messages table:

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

Works out of the box with OpenClaw's LCM database, Telegram export databases, or any custom schema.

#### JSONL

One JSON object per line:

```json
{
  "source": {
    "type": "jsonl",
    "path": "./messages.jsonl",
    "fields": { "id": "id", "content": "text", "sender": "from", "timestamp": "date" }
  }
}
```

#### Custom Adapter

For anything else, point to a JS file:

```json
{ "source": { "type": "custom", "adapterPath": "./my-adapter.js" } }
```

```js
// my-adapter.js
module.exports = {
  name: 'my-source',
  validate() { return { ok: true }; },
  getMessages(afterId) {
    // Return array of { id, content, sender, timestamp }
    return [...]
  }
};
```

## CLI

```
clawmem init [--force]                    Create memory database
clawmem extract [--dry-run] [--reprocess] Run extraction pipeline
clawmem stats                             Show database statistics
clawmem search <query>                    Full-text search facts and topics
clawmem who <keyword>                     Find members by expertise
```

## Programmatic API

```js
const clawmem = require('clawmem');

// Initialize
clawmem.init('./memory.db');

// Create adapter
const adapter = clawmem.adapters.sqlite.create({
  path: './chat.db',
  table: 'messages',
  columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
});

// Extract
await clawmem.extract(adapter, './memory.db', {
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-5-nano',
  },
});

// Query
const facts = clawmem.query.searchFacts('./memory.db', 'kubernetes');
const experts = clawmem.query.whoKnows('./memory.db', 'python');
const topics = clawmem.query.searchTopics('./memory.db', 'deployment');
const stats = clawmem.query.getStats('./memory.db');
```

## Cron Setup

```bash
*/15 * * * * cd /path/to/project && CLAWMEM_LLM_API_KEY=key node src/cli.js extract >> /tmp/clawmem.log 2>&1
```

## Schema

clawmem creates these tables in SQLite:

| Table | Contents |
|-------|----------|
| `members` | username, display_name, expertise, projects, first/last seen |
| `facts` | category, content, source member, tags, confidence, date |
| `topics` | name, summary, participants, tags, date |
| `extraction_state` | cursor position, run counters |
| `*_fts` | FTS5 full-text search indexes (auto-synced via triggers) |

Query directly:

```bash
sqlite3 -json clawmem.db "SELECT * FROM facts_fts WHERE facts_fts MATCH 'docker'"
sqlite3 -json clawmem.db "SELECT display_name, expertise FROM members WHERE expertise LIKE '%python%'"
sqlite3 -json clawmem.db "SELECT name, summary FROM topics ORDER BY created_at DESC LIMIT 10"
```

## Requirements

- Node.js >= 18 (uses built-in `fetch`)
- `sqlite3` CLI with FTS5 support (included on macOS and most Linux distros)

## Background

Built as the memory layer for [LEVI](https://github.com/pandore/limbai-tech), an AI community agent running on [OpenClaw](https://github.com/open-claw/openclaw) in the LIMB.AI/TECH Telegram group. Extracted into a standalone library because every community chat deserves searchable memory.

## License

MIT
