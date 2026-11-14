// The only file that knows Gemini's request format. models.js decides which model to
// use and reserves the request; this file sends it and says how it went. It also keeps a
// video in Gemini's file store for the short time an import needs it (videoFiles).

import { ImportError } from './errors.js';

const API_HOST = 'generativelanguage.googleapis.com';
const ENDPOINT = `https://${API_HOST}/v1beta/interactions`;
const UPLOAD_ENDPOINT = `https://${API_HOST}/upload/v1beta/files`;
const FILES_BASE = `https://${API_HOST}/v1beta/`;
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

// Google said the model is overloaded (503). That lasts minutes or more, longer than the
// quick Workflow retries, so the request moves on to the next model (models.js), and when
// every model is busy the Workflow waits and tries again (workflow.js).
export class ModelBusyError extends Error {
  constructor(detail) {
    super('model_busy');
    this.name = 'ModelBusyError';
    this.detail = detail;
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

function requestBody({ model, prompt, schema, videoUrl, videoType }) {
  const input = [{ type: 'text', text: prompt }];
  // No media resolution: Google's docs don't say a YouTube link accepts it, and a refused
  // field would look like a refused video. An uploaded file is sent with its type, a
  // YouTube link without one, as Google's examples do.
  if (videoUrl) input.unshift({ type: 'video', uri: videoUrl, ...(videoType && { mime_type: videoType }) });
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

// Google's own words for an error, short enough to keep on the import row.
function googleReason(status, text) {
  let message = text;
  try {
    message = JSON.parse(text)?.error?.message ?? text;
  } catch {
    // Not JSON: keep the raw text.
  }
  return `Gemini ${status}: ${message}`.slice(0, 500);
}

function failureFrom(status, text, videoUrl) {
  if (status === 429) return quotaErrorFrom(text);
  const detail = googleReason(status, text);
  if (status === 503) return new ModelBusyError(detail);
  // A rejected request won't get better by itself, so only a server error is tried again.
  if (status >= 500) return new ImportError('llm_error', { retryable: true, detail });
  return videoUrl ? new VideoRefusedError() : new ImportError('llm_error', { detail });
}

// Sends one request and returns the model's answer as parsed JSON. Throws QuotaError,
// ModelBusyError, VideoRefusedError, or ImportError (llm_error for other temporary
// problems, bad_result for an answer that can't be read). `videoUrl` is a YouTube link or
// an uploaded file's uri (then with `videoType`). `logPrompt: false` keeps a prompt that
// holds the user's own text (a translation) out of the logs.
export async function callModel({ env, model, prompt, schema, videoUrl, videoType, logPrompt = true }) {
  // Sending nothing without a key: a mistake must never reach Google half-configured.
  if (!env.GEMINI_API_KEY) throw new ImportError('llm_error', { detail: 'GEMINI_API_KEY is not set' });

  // One line per real request, so a bad result can be traced to what the model was sent.
  // Never add the key or the headers. Import prompts hold only our instructions and a public
  // video description; a translation's holds the user's recipe, so it is never logged.
  console.log(`LLM call: model=${model} video=${videoUrl ?? 'none'}\n${logPrompt ? prompt : '(prompt not logged: user text)'}`);

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
      body: JSON.stringify(requestBody({ model, prompt, schema, videoUrl, videoType })),
    });
  } catch (error) {
    const detail = `Gemini request failed: ${error.name}: ${error.message}`;
    console.log(`LLM call failed: model=${model} ${detail}`);
    throw new ImportError('llm_error', { retryable: true, detail });
  }
  if (!response.ok) {
    // Google's error text says why; it never contains the key.
    const text = await response.text().catch(() => '');
    console.log(`LLM call failed: model=${model} status=${response.status}\n${text.slice(0, 2000)}`);
    throw failureFrom(response.status, text, videoUrl);
  }

  const interaction = await response.json().catch(() => null);
  if (interaction?.status && interaction.status !== 'completed') {
    const detail = `Gemini answered with status ${interaction.status}`;
    console.log(`LLM call failed: model=${model} ${detail}`);
    throw new ImportError('llm_error', { retryable: true, detail });
  }
  return parseOutput(outputText(interaction));
}

// ---- Videos the model can't read from a link ----
// Gemini reads a YouTube video from its link. Any other video has to be uploaded to its
// file store first (free, 2 GB a file, deleted by Google after 48 hours), and the model is
// then given the file's uri.

// A big file takes a while to send, but the step it runs in has 15 minutes in all.
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const FILE_POLL_MS = 5 * 1000;
const FILE_POLLS = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const uploadFailed = (detail) => new ImportError('llm_error', { retryable: true, detail: `Gemini upload: ${detail}`.slice(0, 500) });

async function fileRequest(env, url, init, what) {
  if (!env.GEMINI_API_KEY) throw new ImportError('llm_error', { detail: 'GEMINI_API_KEY is not set' });
  try {
    return await fetch(url, { ...init, headers: { 'x-goog-api-key': env.GEMINI_API_KEY, ...init.headers } });
  } catch (error) {
    throw uploadFailed(`${what} failed: ${error.name}: ${error.message}`);
  }
}

// Uploads a video of `bytes` bytes from the stream `body`, without holding it in memory.
// Returns { name, uri, mimeType } to keep with the import. Google's upload takes two
// requests: one that says what is coming and answers with where to send it, then the bytes.
async function uploadVideo({ env, body, bytes, mimeType }) {
  const start = await fileRequest(
    env,
    UPLOAD_ENDPOINT,
    {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: 'recipe video' } }),
    },
    'start',
  );
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw uploadFailed(`start answered ${start.status}: ${await start.text().catch(() => '')}`);
  // The address comes from a response, so the key is only sent on to Google's own host.
  if (!uploadUrl.startsWith(`https://${API_HOST}/`)) throw uploadFailed('start answered with an unexpected upload address');

  // A stream of known length, so the request carries a Content-Length as Google requires.
  const sized = body.pipeThrough(new FixedLengthStream(bytes));
  const sent = await fileRequest(
    env,
    uploadUrl,
    {
      method: 'POST',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: sized,
    },
    'upload',
  );
  const file = sent.ok ? (await sent.json().catch(() => null))?.file : null;
  if (!file?.name || !file.uri) throw uploadFailed(`upload answered ${sent.status}`);
  console.log(`Video uploaded to Gemini: ${file.name}, ${bytes} bytes`);
  return { name: file.name, uri: file.uri, mimeType };
}

// Waits until Gemini has processed an uploaded video, which takes a few seconds. Throws
// VideoRefusedError when the file can't be used (processing failed, or it is gone), and a
// retryable llm_error when it is still not ready, so the stage's own retries keep waiting.
async function waitUntilReady({ env, file, pollMs = FILE_POLL_MS }) {
  for (let poll = 1; ; poll++) {
    const response = await fileRequest(env, FILES_BASE + file.name, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, 'file check');
    if (response.status === 403 || response.status === 404) throw new VideoRefusedError();
    if (!response.ok) throw uploadFailed(`file check answered ${response.status}`);
    const { state } = await response.json();
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') throw new VideoRefusedError();
    if (poll === FILE_POLLS) throw uploadFailed('the video is still being processed');
    await sleep(pollMs);
  }
}

// Deletes an uploaded video. A failure is only logged: Google deletes it after 48 hours anyway.
async function removeVideo({ env, file }) {
  try {
    const response = await fileRequest(env, FILES_BASE + file.name, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, 'delete');
    if (!response.ok) console.log(`Video not deleted from Gemini: ${file.name}, status ${response.status}`);
  } catch (error) {
    console.log(`Video not deleted from Gemini: ${file.name}, ${error.detail ?? error.message}`);
  }
}

export const videoFiles = { upload: uploadVideo, waitUntilReady, remove: removeVideo };
