/**
 * llm.js — Model-agnostic LLM client.
 * Uses Vercel AI SDK for structured output with Zod schema validation.
 * Supports: any OpenAI-compatible API (OpenAI, Gemini, Groq, Ollama, etc.) and native Anthropic.
 */

const { z } = require('zod');
const { generateText, Output, NoObjectGeneratedError } = require('ai');
const { ENTITY_DEFS } = require('./profiles');

const EXTRACTION_PROMPT = `Analyze these chat messages and extract structured knowledge.

MESSAGES:
{messages}

Extract and return JSON with exactly this structure:
{
  "members": [
    {
      "username": "string or null",
      "display_name": "string",
      "expertise": "comma-separated skills/knowledge areas demonstrated",
      "projects": "comma-separated projects/tools they actively use or build"
    }
  ],
  "facts": [
    {
      "category": "one of: tool, technique, opinion, experience, resource, announcement",
      "content": "the factual claim or insight, 1-2 sentences",
      "source_member": "display_name of who said it",
      "tags": "comma-separated relevant tags",
      "confidence": 0.0 to 1.0
    }
  ],
  "topics": [
    {
      "name": "short topic title",
      "summary": "1-2 sentence summary of the discussion",
      "participants": "comma-separated display_names",
      "tags": "comma-separated relevant tags"
    }
  ]
}

Rules:
- Only extract information explicitly stated in messages, don't infer
- Skip greetings, small talk, and messages with no informational content
- Extract durable knowledge useful months later, not ephemeral news
- NEVER extract API keys, tokens, passwords, secrets, or credentials — these are security-sensitive and must not be stored

Member rules:
- "expertise": only list skills where the person shows SUBSTANTIVE knowledge, not casual mentions
- "projects": only list tools/products a person ACTIVELY USES or BUILDS. Recommending, reviewing, or sharing news about a tool does NOT make it their project
- Only include members who shared genuine expertise or project info

Fact rules:
- Category must match content meaning: "tool" for tool-specific info, "technique" for methods/workflows, "opinion" for personal views, "experience" for firsthand accounts, "resource" for links/courses/repos, "announcement" for releases/launches
- Confidence: 0.9+ for verified specifics (pricing, versions, benchmarks). 0.75-0.85 for opinions and personal experiences. 0.5-0.7 for secondhand claims or speculation
- Tags should be lowercase, useful for search

If no meaningful content found, return empty arrays`;

function buildUpdateSchema(entities) {
  const updateFragments = [];
  if (entities.includes('decisions')) {
    updateFragments.push('    "decisions": [{ "id": "number (from EXISTING KNOWLEDGE)", "status": "proposed|agreed|revisited", "context": "optional new context" }]');
  }
  if (entities.includes('tasks')) {
    updateFragments.push('    "tasks": [{ "id": "number (from EXISTING KNOWLEDGE)", "status": "open|done|blocked" }]');
  }
  if (entities.includes('questions')) {
    updateFragments.push('    "questions": [{ "id": "number (from EXISTING KNOWLEDGE)", "answer": "the answer", "answered_by": "display_name", "status": "answered" }]');
  }
  if (updateFragments.length === 0) return '';
  return `  "updates": {\n${updateFragments.join(',\n')}\n  }`;
}

function buildPrompt(formattedMessages, profileConfig, options = {}) {
  const { entities, factCategories, memberLabels } = profileConfig;
  const { overlapMessages, contextSection, knownMembers } = options;

  // Build JSON schema with only enabled entities
  const schemaFragments = [];
  for (const entity of entities) {
    const def = ENTITY_DEFS[entity];
    if (!def) continue;
    if (entity === 'members') {
      schemaFragments.push(def.promptFragment(memberLabels));
    } else if (entity === 'facts') {
      schemaFragments.push(def.promptFragment(memberLabels, factCategories));
    } else {
      schemaFragments.push(def.promptFragment());
    }
  }

  // Add update schema if context is present
  if (contextSection) {
    const updateSchema = buildUpdateSchema(entities);
    if (updateSchema) schemaFragments.push(updateSchema);
  }

  // Build rules with only enabled entities
  const rulesFragments = [];
  for (const entity of entities) {
    const def = ENTITY_DEFS[entity];
    if (!def) continue;
    if (entity === 'members') {
      rulesFragments.push(def.rules(memberLabels));
    } else if (entity === 'facts') {
      rulesFragments.push(def.rules(memberLabels, factCategories));
    } else {
      rulesFragments.push(def.rules());
    }
  }

  // Add known-members dedup rule
  if (knownMembers?.length > 0 && entities.includes('members')) {
    rulesFragments.push(`Known member rules:
- Members listed in KNOWN MEMBERS are already stored. Only include a known member in "members" if these messages reveal NEW expertise or projects not yet captured
- For known members with no new info, omit them entirely from the output`);
  }

  // Add update rules if context is present
  if (contextSection) {
    rulesFragments.push(`Update rules:
- ONLY reference IDs from the EXISTING KNOWLEDGE section above
- Only update status when the conversation EXPLICITLY confirms a change (e.g., "we agreed on X", "task Y is done", "the answer to Z is...")
- Do not update entities that are not mentioned in the current messages
- If unsure whether something is an update or a new entity, create a new entity`);
  }

  // Build context blocks
  let contextBlock = '';
  if (knownMembers?.length > 0) {
    contextBlock += `\nKNOWN MEMBERS (already in database): ${knownMembers.join(', ')}\n`;
  }
  if (overlapMessages) {
    contextBlock += `\nPREVIOUS MESSAGES (context only — do NOT extract from these, they were already processed):\n${overlapMessages}\n`;
  }
  if (contextSection) {
    contextBlock += `\nEXISTING KNOWLEDGE (from previous extractions — update these if the conversation references changes):\n${contextSection}\n`;
  }

  return `Analyze these chat messages and extract structured knowledge.
${contextBlock}
MESSAGES:
${formattedMessages}

Extract and return JSON with exactly this structure:
{
${schemaFragments.join(',\n')}
}

Rules:
- Only extract information explicitly stated in messages, don't infer
- Skip greetings, small talk, and messages with no informational content
- Extract durable knowledge useful months later, not ephemeral news
- NEVER extract API keys, tokens, passwords, secrets, or credentials — these are security-sensitive and must not be stored

${rulesFragments.join('\n\n')}

If no meaningful content found, return empty arrays`;
}

function formatMessages(messages) {
  return messages.map(m => {
    const sender = m.sender || m.senderName || 'unknown';
    const time = m.timestamp || '';
    return `[${time}] ${sender}: ${m.content}`;
  }).join('\n');
}

/** Detect whether to use Anthropic Messages API. */
function isAnthropic(config) {
  // Explicit provider override takes priority
  if (config.provider === 'openai') return false;
  if (config.provider === 'anthropic') return true;
  if (config.baseUrl?.includes('anthropic.com')) return true;
  return false;
}

// --- Zod entity schemas for structured output ---

const memberSchema = z.object({
  username: z.string().nullable(),
  display_name: z.string(),
  expertise: z.string().nullable(),
  projects: z.string().nullable(),
});

const factSchema = z.object({
  category: z.string(),
  content: z.string(),
  source_member: z.string().nullable(),
  tags: z.string().nullable(),
  confidence: z.number().nullable(),
});

const topicSchema = z.object({
  name: z.string(),
  summary: z.string().nullable(),
  participants: z.string().nullable(),
  tags: z.string().nullable(),
});

const decisionSchema = z.object({
  description: z.string(),
  participants: z.string().nullable(),
  context: z.string().nullable(),
  status: z.string().nullable(),
  tags: z.string().nullable(),
});

const taskSchema = z.object({
  description: z.string(),
  assignee: z.string().nullable(),
  deadline: z.string().nullable(),
  status: z.string().nullable(),
  source_member: z.string().nullable(),
  tags: z.string().nullable(),
});

const questionSchema = z.object({
  question: z.string(),
  asker: z.string().nullable(),
  answer: z.string().nullable(),
  answered_by: z.string().nullable(),
  status: z.string().nullable(),
  tags: z.string().nullable(),
});

const eventSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  event_date: z.string().nullable(),
  location: z.string().nullable(),
  attendees: z.string().nullable(),
  tags: z.string().nullable(),
});

const ENTITY_SCHEMAS = {
  members: memberSchema,
  facts: factSchema,
  topics: topicSchema,
  decisions: decisionSchema,
  tasks: taskSchema,
  questions: questionSchema,
  events: eventSchema,
};

// Update sub-schemas (for context-aware extraction)
const decisionUpdateSchema = z.object({ id: z.number(), status: z.string(), context: z.string().nullable() });
const taskUpdateSchema = z.object({ id: z.number(), status: z.string() });
const questionUpdateSchema = z.object({ id: z.number(), answer: z.string(), answered_by: z.string().nullable(), status: z.string().nullable() });

/**
 * Build a Zod extraction schema dynamically from profile entities.
 * Only includes entity types that the profile uses.
 */
function buildExtractionSchema(entities, hasContext) {
  const shape = {};
  for (const entity of entities) {
    if (ENTITY_SCHEMAS[entity]) {
      shape[entity] = z.array(ENTITY_SCHEMAS[entity]).nullable();
    }
  }

  if (hasContext) {
    const updateShape = {};
    if (entities.includes('decisions')) updateShape.decisions = z.array(decisionUpdateSchema).nullable();
    if (entities.includes('tasks')) updateShape.tasks = z.array(taskUpdateSchema).nullable();
    if (entities.includes('questions')) updateShape.questions = z.array(questionUpdateSchema).nullable();
    if (Object.keys(updateShape).length > 0) {
      shape.updates = z.object(updateShape).nullable();
    }
  }

  return z.object(shape);
}

// --- Provider selection ---

/**
 * Create the right AI SDK provider based on config.
 * - Anthropic: uses @ai-sdk/anthropic (optional dep)
 * - Everything else: uses @ai-sdk/openai-compatible (any baseUrl)
 */
function createProvider(config) {
  if (!config.baseUrl) throw new Error('LLM base URL not configured');
  const base = config.baseUrl.replace(/\/+$/, '');

  if (isAnthropic(config)) {
    try {
      const { createAnthropic } = require('@ai-sdk/anthropic');
      return createAnthropic({ baseURL: base, apiKey: config.apiKey });
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error('Direct Anthropic API requires @ai-sdk/anthropic. Install it with: npm install @ai-sdk/anthropic');
      }
      throw e;
    }
  }

  const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
  return createOpenAICompatible({ baseURL: base, apiKey: config.apiKey, name: 'llm' });
}

// --- JSON repair (private, used as fallback) ---

/**
 * Attempt to repair truncated or malformed JSON from LLM output.
 * Handles: code fences, trailing commas, truncated arrays/objects.
 */
function repairJson(text) {
  // Strip code fences
  let s = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Try clean parse first
  try { return JSON.parse(s); } catch {}

  // Remove trailing commas before } or ]
  let cleaned = s.replace(/,(\s*[\]}])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}

  // Truncation repair: walk backward from end, try closing brackets at each '}'
  for (let i = cleaned.length - 1; i > 0; i--) {
    if (cleaned[i] !== '}') continue;
    const truncated = cleaned.substring(0, i + 1);
    const closers = getUnclosedBrackets(truncated);
    if (closers.length === 0) continue;
    try { return JSON.parse(truncated + closers); } catch { continue; }
  }

  throw new Error('JSON parse failed (repair unsuccessful)');
}

/** Count unclosed [ and { and return the closing sequence needed. */
function getUnclosedBrackets(text) {
  const stack = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && text[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  return stack.reverse().join('');
}

// --- Normalize null arrays to empty arrays ---

function normalizeOutput(output) {
  if (!output || typeof output !== 'object') return output;
  for (const key of Object.keys(output)) {
    if (output[key] === null && key !== 'updates') {
      output[key] = [];
    }
  }
  if (output.updates && typeof output.updates === 'object') {
    for (const key of Object.keys(output.updates)) {
      if (output.updates[key] === null) output.updates[key] = [];
    }
  }
  return output;
}

// --- Core extraction ---

async function extract(messages, config) {
  const {
    apiKey,
    baseUrl,
    model,
    promptTemplate,
    profileConfig,
    overlapMessages,
    contextSection,
    knownMembers,
    maxRetries,
  } = config;

  if (!apiKey) throw new Error('LLM API key not configured');
  if (!baseUrl) throw new Error('LLM base URL not configured');
  if (!model) throw new Error('LLM model not configured');

  const formatted = formatMessages(messages);
  let prompt;
  if (promptTemplate) {
    prompt = promptTemplate.replace('{messages}', formatted);
  } else if (profileConfig) {
    prompt = buildPrompt(formatted, profileConfig, {
      overlapMessages: overlapMessages || null,
      contextSection: contextSection || null,
      knownMembers: knownMembers || null,
    });
  } else {
    prompt = EXTRACTION_PROMPT.replace('{messages}', formatted);
  }

  const provider = createProvider(config);

  // promptTemplate path: plain text mode + repairJson (deprecated, backward compat)
  if (promptTemplate) {
    const result = await generateText({
      model: provider(model),
      system: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.',
      prompt,
      temperature: 0.1,
      maxTokens: 4096,
      maxRetries: maxRetries ?? 3,
    });
    return repairJson(result.text);
  }

  // Standard path: structured output with Zod schema
  const entities = profileConfig?.entities || ['members', 'facts', 'topics'];
  const hasContext = !!contextSection;
  const schema = buildExtractionSchema(entities, hasContext);

  try {
    const result = await generateText({
      model: provider(model),
      system: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.',
      prompt,
      output: Output.object({ schema }),
      temperature: 0.1,
      maxTokens: 4096,
      maxRetries: maxRetries ?? 3,
    });
    return normalizeOutput(result.output);
  } catch (err) {
    // Fallback: if structured output fails, try repairJson on the raw text
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      try {
        const repaired = repairJson(err.text);
        return normalizeOutput(repaired);
      } catch {
        // repairJson also failed — throw the original error
      }
    }
    throw err;
  }
}

/**
 * Thin facade over extract() — preserves the existing call interface.
 * SDK handles retries internally via maxRetries option.
 */
async function extractWithRetry(messages, config, maxRetries = 3) {
  return extract(messages, { ...config, maxRetries });
}

/**
 * Extract structured knowledge from raw text without adapter/cursor/batching.
 * Designed for MCP ingest tool — no console.log, no stdout writes.
 *
 * @param {string} text - Raw text to extract from
 * @param {object} config - Full config with llm section { llm: { baseUrl, apiKey, model } }
 * @param {object} profileConfig - Profile config from getProfile()
 * @returns {Promise<object>} Extracted entities { members, facts, decisions, ... }
 */
async function extractFromText(text, config, profileConfig) {
  if (!text || typeof text !== 'string') {
    throw new Error('text is required and must be a string');
  }
  if (!config?.llm?.baseUrl || !config?.llm?.apiKey) {
    throw new Error('LLM not configured. Set llm config in lizardbrain.json.');
  }
  if (!config?.llm?.model) {
    throw new Error('LLM model not configured. Set llm.model in lizardbrain.json.');
  }

  // Wrap text as a message array — formatMessages() expects [{content, sender, timestamp}]
  const messages = [{ content: text, sender: 'user', timestamp: '' }];

  // extractWithRetry expects flat LLM config (not nested under .llm)
  const llmConfig = { ...config.llm };
  if (profileConfig) {
    llmConfig.profileConfig = profileConfig;
  }

  const result = await extractWithRetry(messages, llmConfig);
  return result;
}

module.exports = { extract, extractWithRetry, extractFromText, buildPrompt, formatMessages, isAnthropic, buildExtractionSchema, createProvider, repairJson, EXTRACTION_PROMPT };
