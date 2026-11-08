// The only file that knows Gemini's request format. models.js decides which model to
// use and reserves the request; this file sends it and says how it went.

import { ImportError } from './errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
// Google's REST examples pin this revision, and the response shape read below is theirs.
const API_REVISION = '2026-05-20';

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
async function quotaErrorFrom(response) {
  const body = await response.json().catch(() => ({}));
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  return new QuotaError({ daily: JSON.stringify(details).includes('PerDay'), retryDelayMs: retryDelayFrom(details) });
}

function requestBody({ model, prompt, schema, videoUrl }) {
  const input = [{ type: 'text', text: prompt }];
  if (videoUrl) input.unshift({ type: 'video', uri: videoUrl, resolution: 'low' });
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

async function failureFrom(response, videoUrl) {
  if (response.status === 429) return quotaErrorFrom(response);
  // A rejected request won't get better by itself, so only a server error is tried again.
  if (response.status >= 500) return new ImportError('llm_error', { retryable: true });
  return videoUrl ? new VideoRefusedError() : new ImportError('llm_error');
}

// Sends one request and returns the model's answer as parsed JSON. Throws QuotaError,
// VideoRefusedError, or ImportError (llm_error for temporary problems, bad_result for an
// answer that can't be read).
export async function callModel({ env, model, prompt, schema, videoUrl }) {
  // Sending nothing without a key: a mistake must never reach Google half-configured.
  if (!env.GEMINI_API_KEY) throw new ImportError('llm_error');

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(requestBody({ model, prompt, schema, videoUrl })),
    });
  } catch {
    throw new ImportError('llm_error', { retryable: true });
  }
  if (!response.ok) throw await failureFrom(response, videoUrl);

  const interaction = await response.json().catch(() => null);
  if (interaction?.status && interaction.status !== 'completed') {
    throw new ImportError('llm_error', { retryable: true });
  }
  return parseOutput(outputText(interaction));
}
