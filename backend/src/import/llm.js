// The only file that knows Gemini's request format. models.js decides which model to
// use and reserves the request; this file sends it and says how it went.

import { ImportError } from './errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Google's REST examples pin this revision, and the response shape read below is theirs.
const API_REVISION = '2026-05-20';

// Video calls have taken over 5 minutes. A request must end before its Workflow step
// (15 minutes, workflow.js) gives up, or the retry overlaps a call that is still running.
const REQUEST_TIMEOUT_MS = 14 * 60 * 1000;

const DEFAULT_RETRY_DELAY_MS = 20 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 1000;

// Google said the model is out of quota. `daily` means it stays out until the daily
// reset; otherwise it may be a short limit, worth one more try after `retryDelayMs`.
export class QuotaError extends Error {
  constructor({ daily, retryDelayMs }) {
    super('quota');
    this.name = 'QuotaError';
    this.daily = daily;
    this.retryDelayMs = retryDelayMs;
  }
}

// Google wouldn't take the video itself (it may be blocked or unreadable).
export class VideoRefusedError extends Error {
  constructor() {
    super('video_refused');
    this.name = 'VideoRefusedError';
  }
}

function retryDelayFrom(details) {
  const retryInfo = details.find((detail) => String(detail?.['@type']).endsWith('RetryInfo'));
  const seconds = Number.parseFloat(retryInfo?.retryDelay);
  return seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : DEFAULT_RETRY_DELAY_MS;
}

// Google doesn't reliably say which limit was hit: some 429s name a per-day quota in
// their details, others say nothing.
function quotaErrorFrom(text) {
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // A 429 without a JSON body is treated like a bare one.
  }
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  return new QuotaError({ daily: JSON.stringify(details).includes('PerDay'), retryDelayMs: retryDelayFrom(details) });
}

function requestBody({ model, prompt, schema, videoUrl }) {
  const input = [{ type: 'text', text: prompt }];
  // No media resolution: Google's docs don't say a YouTube link accepts it, and a refused
  // field would look like a refused video.
  if (videoUrl) input.unshift({ type: 'video', uri: videoUrl });
  return { model, input, response_format: { type: 'text', mime_type: 'application/json', schema } };
}

function outputText(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  return steps
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('');
}

// Google doesn't confirm that a JSON schema is honoured with video input, so the answer
// may arrive wrapped in a code fence, and is always checked by the caller.
function parseOutput(text) {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Handled below: not JSON is the same failure as the wrong kind of JSON.
  }
  throw new ImportError('bad_result', { retryable: true });
}

function failureFrom(status, text, videoUrl) {
  if (status === 429) return quotaErrorFrom(text);
  // A rejected request won't get better by itself, so only a server error is tried again.
  if (status >= 500) return new ImportError('llm_error', { retryable: true });
  return videoUrl ? new VideoRefusedError() : new ImportError('llm_error');
}

// Sends one request and returns the model's answer as parsed JSON. Throws QuotaError,
// VideoRefusedError, or ImportError (llm_error for temporary problems, bad_result for an
// answer that can't be read).
export async function callModel({ env, model, prompt, schema, videoUrl }) {
  // Sending nothing without a key: a mistake must never reach Google half-configured.
  if (!env.GEMINI_API_KEY) throw new ImportError('llm_error');

  // One line per real request, so a bad result can be traced to what the model was sent.
  // Never add the key or the headers. Prompts hold only our instructions and a public video
  // description: if one ever holds a user's own text, stop logging it here.
  console.log(`LLM call: model=${model} video=${videoUrl ?? 'none'}\n${prompt}`);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(requestBody({ model, prompt, schema, videoUrl })),
    });
  } catch (error) {
    console.log(`LLM call failed: model=${model} ${error.name}: ${error.message}`);
    throw new ImportError('llm_error', { retryable: true });
  }
  if (!response.ok) {
    // Google's error text says why; it never contains the key.
    const text = await response.text().catch(() => '');
    console.log(`LLM call failed: model=${model} status=${response.status}\n${text.slice(0, 2000)}`);
    throw failureFrom(response.status, text, videoUrl);
  }

  const interaction = await response.json().catch(() => null);
  if (interaction?.status && interaction.status !== 'completed') {
    console.log(`LLM call failed: model=${model} interaction status=${interaction.status}`);
    throw new ImportError('llm_error', { retryable: true });
  }
  return parseOutput(outputText(interaction));
}
