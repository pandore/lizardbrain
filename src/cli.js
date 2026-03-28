#!/usr/bin/env node
/**
 * clawmem CLI — Command-line interface for clawmem.
 *
 * Usage:
 *   clawmem init [--force]                    Create memory database
 *   clawmem extract [--dry-run] [--reprocess] Run extraction pipeline
 *   clawmem stats                             Show database statistics
 *   clawmem search <query>                    Search facts and topics
 *   clawmem who <keyword>                     Find members with expertise
 *
 * Configuration:
 *   Place a clawmem.json in your working directory, or use environment variables.
 *   See README.md for details.
 */

const path = require('path');
const clawmem = require('./index');
const config = require('./config');
const { createDriver, dbExists } = require('./driver');

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
      const result = clawmem.init(cfg.memoryDbPath, { force: flag('force') });
      console.log(result.message);
      break;
    }

    case 'extract': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const adapter = createAdapter(cfg.source);
      const rosterOutput = flag('roster') ? args[args.indexOf('--roster') + 1] : (cfg.rosterPath || null);
      const result = await clawmem.extract(adapter, driver, cfg, {
        dryRun: flag('dry-run'),
        reprocess: flag('reprocess'),
        rosterPath: rosterOutput,
        enrichUrls: !flag('no-enrich'),
        noEmbed: flag('no-embed'),
      });

      driver.close();

      if (!result.ok) {
        console.error(`Extraction failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stats': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const stats = clawmem.query.getStats(driver);
      console.log('\n=== clawmem stats ===');
      console.log(`Members:  ${stats.members}`);
      console.log(`Facts:    ${stats.facts}`);
      console.log(`Topics:   ${stats.topics}`);
      console.log(`\nDriver:   ${stats.driver}${stats.vectors ? ' (vectors enabled)' : ''}`);
      console.log(`Search:   ${stats.vectors ? 'hybrid (FTS5 + kNN + RRF)' : 'FTS5'}`);

      if (stats.vectors) {
        const embeddings = require('./embeddings');
        const estats = embeddings.getEmbeddingStats(driver);
        if (estats.dimensions > 0) {
          console.log(`\nEmbeddings:`);
          console.log(`  model:      ${estats.model}`);
          console.log(`  dimensions: ${estats.dimensions}`);
          console.log(`  facts:      ${estats.facts.embedded}/${estats.facts.total}`);
          console.log(`  topics:     ${estats.topics.embedded}/${estats.topics.total}`);
          console.log(`  members:    ${estats.members.embedded}/${estats.members.total}`);
        }
      }

      console.log(`\nMessages processed: ${stats.messagesProcessed}`);
      console.log(`Last processed ID:  ${stats.lastProcessedId}`);
      console.log(`Last run:           ${stats.lastRun}`);
      console.log('');
      driver.close();
      break;
    }

    case 'search': {
      const queryText = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
      if (!queryText) {
        console.log('Usage: clawmem search <query>');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      const { search: hybridSearch } = require('./search');
      const embCfg = (cfg.embedding?.enabled && cfg.embedding?.apiKey) ? cfg.embedding : null;
      const result = await hybridSearch(driver, queryText, {
        limit: parseInt(args[args.indexOf('--limit') + 1]) || 10,
        ftsOnly: flag('fts-only'),
        embeddingConfig: embCfg,
      });

      if (flag('json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n[${result.mode} search]\n`);
        for (const r of result.results) {
          console.log(`  [${r.source}] ${r.text}`);
          if (r.member) console.log(`    — ${r.member}`);
          if (r.confidence) console.log(`    confidence: ${r.confidence}`);
        }
        if (result.results.length === 0) console.log(`No results for "${queryText}"`);
        console.log('');
      }
      driver.close();
      break;
    }

    case 'embed': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }
      if (!cfg.embedding?.enabled) {
        console.log('Embedding not configured. Add an "embedding" block to clawmem.json with enabled: true.');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      if (!driver.capabilities.vectors) {
        console.log('Vector search requires better-sqlite3 + sqlite-vec. Install: npm install better-sqlite3 sqlite-vec');
        driver.close();
        process.exit(1);
      }
      const embeddings = require('./embeddings');

      if (flag('stats')) {
        const estats = embeddings.getEmbeddingStats(driver);
        console.log('\n=== embedding stats ===');
        console.log(`Model:      ${estats.model}`);
        console.log(`Dimensions: ${estats.dimensions}`);
        console.log(`Facts:      ${estats.facts.embedded}/${estats.facts.total}`);
        console.log(`Topics:     ${estats.topics.embedded}/${estats.topics.total}`);
        console.log(`Members:    ${estats.members.embedded}/${estats.members.total}\n`);
      } else {
        const result = await embeddings.backfill(driver, cfg.embedding, { rebuild: flag('rebuild') });
        if (!result.ok) {
          console.error(`Embedding failed: ${result.error}`);
          driver.close();
          process.exit(1);
        }
      }
      driver.close();
      break;
    }

    case 'who': {
      const keyword = args.slice(1).join(' ');
      if (!keyword) {
        console.log('Usage: clawmem who <keyword>');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const members = clawmem.query.whoKnows(driver, keyword);
      driver.close();

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

    case 'roster': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const roster = clawmem.query.generateRoster(driver);
      driver.close();

      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
      if (outputPath) {
        const fs = require('fs');
        fs.writeFileSync(outputPath, roster.content);
        console.log(`Roster: ${roster.count} members → ${outputPath}`);
      } else {
        process.stdout.write(roster.content);
      }
      break;
    }

    default:
      console.log(`clawmem — Lightweight structured memory for community chats

Commands:
  init [--force]                    Create memory database
  extract [--dry-run] [--reprocess] Run extraction pipeline
  embed [--stats] [--rebuild]       Manage vector embeddings
  stats                             Show database statistics
  search <query> [--json] [--fts-only] [--limit N]  Search knowledge
  who <keyword>                     Find members by expertise
  roster [--output path]            Generate member roster

Options:
  --config <path>                   Path to clawmem.json config file
  --roster <path>                   Generate roster after extraction
  --no-enrich                       Skip URL metadata enrichment
  --no-embed                        Skip auto-embedding after extraction

Environment variables:
  CLAWMEM_DB_PATH                   Path to memory database
  CLAWMEM_LLM_BASE_URL             LLM API base URL
  CLAWMEM_LLM_API_KEY              LLM API key
  CLAWMEM_LLM_MODEL                LLM model name
  CLAWMEM_EMBEDDING_BASE_URL       Embedding API base URL
  CLAWMEM_EMBEDDING_API_KEY        Embedding API key
  CLAWMEM_EMBEDDING_MODEL          Embedding model name
`);
  }
}

function createAdapter(sourceConfig) {
  const type = sourceConfig.type || 'sqlite';

  switch (type) {
    case 'sqlite':
      return clawmem.adapters.sqlite.create(sourceConfig);
    case 'jsonl':
      return clawmem.adapters.jsonl.create(sourceConfig);
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
