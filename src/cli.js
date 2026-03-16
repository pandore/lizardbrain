#!/usr/bin/env node
/**
 * chatmem CLI — Command-line interface for chatmem.
 *
 * Usage:
 *   chatmem init [--force]                    Create memory database
 *   chatmem extract [--dry-run] [--reprocess] Run extraction pipeline
 *   chatmem stats                             Show database statistics
 *   chatmem search <query>                    Search facts and topics
 *   chatmem who <keyword>                     Find members with expertise
 *
 * Configuration:
 *   Place a chatmem.json in your working directory, or use environment variables.
 *   See README.md for details.
 */

const path = require('path');
const chatmem = require('./index');
const config = require('./config');

const args = process.argv.slice(2);
const command = args[0];

function flag(name) { return args.includes(`--${name}`); }
function arg(index) { return args[index]; }

async function main() {
  const configPath = flag('config')
    ? args[args.indexOf('--config') + 1]
    : null;

  const cfg = config.load(configPath);

  switch (command) {
    case 'init': {
      const result = chatmem.init(cfg.memoryDbPath, { force: flag('force') });
      console.log(result.message);
      break;
    }

    case 'extract': {
      const db = require('./db');
      if (!db.exists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `chatmem init` first.');
        process.exit(1);
      }

      const adapter = createAdapter(cfg.source);
      const result = await chatmem.extract(adapter, cfg.memoryDbPath, cfg, {
        dryRun: flag('dry-run'),
        reprocess: flag('reprocess'),
      });

      if (!result.ok) {
        console.error(`Extraction failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stats': {
      const db = require('./db');
      if (!db.exists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `chatmem init` first.');
        process.exit(1);
      }

      const stats = chatmem.query.getStats(cfg.memoryDbPath);
      console.log('\n=== chatmem stats ===');
      console.log(`Members:  ${stats.members}`);
      console.log(`Facts:    ${stats.facts}`);
      console.log(`Topics:   ${stats.topics}`);
      console.log(`\nMessages processed: ${stats.messagesProcessed}`);
      console.log(`Last processed ID:  ${stats.lastProcessedId}`);
      console.log(`Last run:           ${stats.lastRun}`);
      console.log('');
      break;
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.log('Usage: chatmem search <query>');
        process.exit(1);
      }

      const facts = chatmem.query.searchFacts(cfg.memoryDbPath, query);
      const topics = chatmem.query.searchTopics(cfg.memoryDbPath, query);

      if (facts.length > 0) {
        console.log('\n--- Facts ---');
        for (const f of facts) {
          console.log(`  [${f.category}] ${f.content}`);
          if (f.source) console.log(`    — ${f.source}`);
        }
      }
      if (topics.length > 0) {
        console.log('\n--- Topics ---');
        for (const t of topics) {
          console.log(`  ${t.name}: ${t.summary}`);
          if (t.participants) console.log(`    participants: ${t.participants}`);
        }
      }
      if (facts.length === 0 && topics.length === 0) {
        console.log(`No results for "${query}"`);
      }
      console.log('');
      break;
    }

    case 'who': {
      const keyword = args.slice(1).join(' ');
      if (!keyword) {
        console.log('Usage: chatmem who <keyword>');
        process.exit(1);
      }

      const members = chatmem.query.whoKnows(cfg.memoryDbPath, keyword);
      if (members.length > 0) {
        console.log(`\nMembers who know about "${keyword}":`);
        for (const m of members) {
          console.log(`  ${m.display_name}${m.username ? ` (@${m.username})` : ''}`);
          if (m.expertise) console.log(`    expertise: ${m.expertise}`);
          if (m.projects) console.log(`    projects: ${m.projects}`);
        }
      } else {
        console.log(`No members found with "${keyword}" expertise`);
      }
      console.log('');
      break;
    }

    default:
      console.log(`chatmem — Lightweight structured memory for community chats

Commands:
  init [--force]                    Create memory database
  extract [--dry-run] [--reprocess] Run extraction pipeline
  stats                             Show database statistics
  search <query>                    Search facts and topics (FTS)
  who <keyword>                     Find members by expertise

Options:
  --config <path>                   Path to chatmem.json config file

Environment variables:
  CHATMEM_DB_PATH                   Path to memory database
  CHATMEM_LLM_BASE_URL             LLM API base URL (OpenAI-compatible)
  CHATMEM_LLM_API_KEY              LLM API key
  CHATMEM_LLM_MODEL                LLM model name
`);
  }
}

function createAdapter(sourceConfig) {
  const type = sourceConfig.type || 'sqlite';

  switch (type) {
    case 'sqlite':
      return chatmem.adapters.sqlite.create(sourceConfig);
    case 'jsonl':
      return chatmem.adapters.jsonl.create(sourceConfig);
    case 'custom':
      if (sourceConfig.adapterPath) {
        const custom = require(path.resolve(sourceConfig.adapterPath));
        return typeof custom.create === 'function' ? custom.create(sourceConfig) : custom;
      }
      throw new Error('Custom adapter requires "adapterPath" in source config');
    default:
      throw new Error(`Unknown adapter type: ${type}. Use sqlite, jsonl, or custom.`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
