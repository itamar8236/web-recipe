// The only file that knows Groq's request format. Groq runs the fallback model: a free
// text-only model that answers when every Gemini model in line is busy or out (models.js decides
// when). It can't watch a video, so it is only ever given text.

import { ImportError } from './errors.js';
import { ModelBusyError, QuotaError } from './llm.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 20 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 1000;

function retryDelayFrom(response) {
  const seconds = Number.parseFloat(response.headers.get('retry-after'));
  return seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : DEFAULT_RETRY_DELAY_MS;
}

function parseOutput(text) {
  try {
    const parsed = JSON.parse(String(text).trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Handled below: not JSON is the same failure as the wrong kind of JSON.
  }
  throw new ImportError('bad_result', { retryable: true });
}

// Sends one text request and returns the answer as parsed JSON. Same contract as
// llm.js's callModel: throws QuotaError, ModelBusyError or ImportError.
export async function callFallbackModel({ env, model, prompt, schema, logPrompt = true }) {
  if (!env.GROQ_API_KEY) throw new ImportError('llm_error', { detail: 'GROQ_API_KEY is not set' });
  console.log(`LLM call: model=${model} (fallback) video=none\n${logPrompt ? prompt : '(prompt not logged: user text)'}`);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } },
      }),
    });
  } catch (error) {
    throw new ImportError('llm_error', { retryable: true, detail: `Groq request failed: ${error.name}: ${error.message}` });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.log(`LLM call failed: model=${model} status=${response.status}\n${text.slice(0, 2000)}`);
    // Groq doesn't say whether a per-minute or a per-day limit was hit, so each is tried once more.
    if (response.status === 429) throw new QuotaError({ daily: false, retryDelayMs: retryDelayFrom(response) });
    const detail = `Groq ${response.status}: ${text}`.slice(0, 500);
    if (response.status === 503) throw new ModelBusyError(detail);
    // A 400 here is usually the model failing to write JSON that fits the schema.
    if (response.status === 400 && text.includes('json_validate_failed')) throw new ImportError('bad_result', { retryable: true, detail });
    throw new ImportError('llm_error', { retryable: response.status >= 500, detail });
  }
  const body = await response.json().catch(() => null);
  return parseOutput(body?.choices?.[0]?.message?.content);
}
