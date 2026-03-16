/**
 * llm.js — Model-agnostic LLM client using OpenAI-compatible API.
 * Works with: OpenAI, Gemini, Groq, Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint.
 */

const EXTRACTION_PROMPT = `Analyze these chat messages and extract structured knowledge.

MESSAGES:
{messages}

Extract and return JSON with exactly this structure:
{
  "members": [
    {
      "username": "string or null",
      "display_name": "string",
      "expertise": "comma-separated skills/knowledge areas mentioned",
      "projects": "comma-separated projects/tools they mentioned working on"
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
- For members, only include those who shared expertise or project info
- Confidence: 1.0 for stated facts, 0.7-0.9 for opinions, 0.5-0.7 for uncertain claims
- Tags should be lowercase, useful for search
- If no meaningful content found, return empty arrays`;

function formatMessages(messages) {
  return messages.map(m => {
    const sender = m.sender || m.senderName || 'unknown';
    const time = m.timestamp || '';
    return `[${time}] ${sender}: ${m.content}`;
  }).join('\n');
}

async function extract(messages, config) {
  const {
    apiKey,
    baseUrl,
    model,
    promptTemplate,
  } = config;

  if (!apiKey) throw new Error('LLM API key not configured');
  if (!baseUrl) throw new Error('LLM base URL not configured');
  if (!model) throw new Error('LLM model not configured');

  const template = promptTemplate || EXTRACTION_PROMPT;
  const formatted = formatMessages(messages);
  const prompt = template.replace('{messages}', formatted);

  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You extract structured knowledge from chat messages. Always respond with valid JSON only.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };

  // Add response_format if supported (OpenAI, Gemini)
  // Some providers don't support it, so we don't fail if absent
  body.response_format = { type: 'json_object' };

  const headers = {
    'Content-Type': 'application/json',
  };

  // Support both Bearer token and API key in URL (some providers use query params)
  if (apiKey.startsWith('sk-') || apiKey.startsWith('AIza')) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from LLM');

  return JSON.parse(content);
}

module.exports = { extract, EXTRACTION_PROMPT };
