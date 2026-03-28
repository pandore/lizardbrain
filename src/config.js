/**
 * config.js — Load clawmem configuration from file or env vars.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  memoryDbPath: './clawmem.db',
  batchSize: 40,
  minMessages: 5,
  rosterPath: null,
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    promptTemplate: null,
  },
  source: {
    type: 'sqlite',
    // rest depends on adapter
  },
  embedding: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: null,
    batchTokenLimit: 8000,
  },
};

function loadEnv(dir) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  }
}

function load(configPath) {
  // Load .env from config directory
  if (configPath) {
    loadEnv(path.dirname(configPath));
  } else {
    loadEnv(process.cwd());
  }

  let fileConfig = {};

  // Try loading config file
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } else {
    // Try default locations
    for (const name of ['clawmem.json', 'clawmem.config.json']) {
      const p = path.join(process.cwd(), name);
      if (fs.existsSync(p)) {
        fileConfig = JSON.parse(fs.readFileSync(p, 'utf-8'));
        break;
      }
    }
  }

  // Merge with defaults and env vars
  const config = {
    memoryDbPath: fileConfig.memoryDbPath || process.env.CLAWMEM_DB_PATH || DEFAULTS.memoryDbPath,
    batchSize: fileConfig.batchSize || parseInt(process.env.CLAWMEM_BATCH_SIZE) || DEFAULTS.batchSize,
    minMessages: fileConfig.minMessages || parseInt(process.env.CLAWMEM_MIN_MESSAGES) || DEFAULTS.minMessages,
    rosterPath: fileConfig.rosterPath || process.env.CLAWMEM_ROSTER_PATH || DEFAULTS.rosterPath,
    llm: {
      baseUrl: fileConfig.llm?.baseUrl || process.env.CLAWMEM_LLM_BASE_URL || process.env.LLM_BASE_URL || DEFAULTS.llm.baseUrl,
      apiKey: fileConfig.llm?.apiKey || process.env.CLAWMEM_LLM_API_KEY || process.env.LLM_API_KEY || DEFAULTS.llm.apiKey,
      model: fileConfig.llm?.model || process.env.CLAWMEM_LLM_MODEL || process.env.LLM_MODEL || DEFAULTS.llm.model,
      promptTemplate: fileConfig.llm?.promptTemplate || DEFAULTS.llm.promptTemplate,
    },
    source: fileConfig.source || DEFAULTS.source,
    embedding: {
      enabled: fileConfig.embedding?.enabled || false,
      baseUrl: fileConfig.embedding?.baseUrl || process.env.CLAWMEM_EMBEDDING_BASE_URL || DEFAULTS.embedding.baseUrl,
      apiKey: fileConfig.embedding?.apiKey || process.env.CLAWMEM_EMBEDDING_API_KEY || DEFAULTS.embedding.apiKey,
      model: fileConfig.embedding?.model || process.env.CLAWMEM_EMBEDDING_MODEL || DEFAULTS.embedding.model,
      dimensions: fileConfig.embedding?.dimensions || DEFAULTS.embedding.dimensions,
      batchTokenLimit: fileConfig.embedding?.batchTokenLimit || parseInt(process.env.CLAWMEM_EMBEDDING_BATCH_LIMIT) || DEFAULTS.embedding.batchTokenLimit,
    },
  };

  return config;
}

module.exports = { load, DEFAULTS };
