// The only file that knows Gemini's request format. models.js decides which model to
// use and reserves the request; this file sends it and says how it went. It also keeps a
// video or a photo in Gemini's file store for the short time an import needs it (geminiFiles).

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

// Google wouldn't take the video or the photo itself (it may be blocked or unreadable).
export class VideoRefusedError extends Error {
  constructor() {
    super('video_refused');
    this.name = 'VideoRefusedError';
  }
}

// An uploaded file is gone from Gemini's store (Google deletes files after 48 hours). For
// a video it is one more way the video can't be used; a photo can't be fetched again.
// Google refused to answer because the answer would copy published, copyrighted text. It
// happened with every model tried on a photo of a well-known recipe site's page.
export class RecitationError extends VideoRefusedError {
  constructor() {
    super();
    this.name = 'RecitationError';
  }
}

export class FileGoneError extends VideoRefusedError {
  constructor() {
    super();
    this.name = 'FileGoneError';
  }
}

// The model can't run any request now: Google says it doesn't exist (retired or renamed)
// or won't take the key. Waiting won't help, so the request moves on to the next model
// (models.js), the same as for a busy one.
export class ModelUnusableError extends Error {
  constructor(detail) {
    super('model_unusable');
    this.name = 'ModelUnusableError';
    this.detail = detail;
  }
}

// Google said the model is overloaded (503). That lasts minutes or more, longer than the
// quick Workflow retries, so the request moves on to the next model (models.js), and when
// every model is busy the Workflow waits and tries again (workflow.js). `counted` says
// Google ran the request anyway (a 524), so it stays in the day's count.
export class ModelBusyError extends Error {
  constructor(detail, { counted = false } = {}) {
    super('model_busy');
    this.name = 'ModelBusyError';
    this.detail = detail;
    this.counted = counted;
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

function requestBody({ model, prompt, schema, videoUrl, videoType, imageUrl, imageType, pageUrl, background }) {
  const input = [{ type: 'text', text: prompt }];
  // No media resolution for a video: Google's docs don't say a YouTube link accepts it, and
  // a refused field would look like a refused video. An uploaded file is sent with its type,
  // a YouTube link without one, as Google's examples do.
  if (videoUrl) input.unshift({ type: 'video', uri: videoUrl, ...(videoType && { mime_type: videoType }) });
  // A photo of a recipe is mostly small print, so it is read at high resolution, which
  // Google documents for an image part.
  if (imageUrl) input.unshift({ type: 'image', uri: imageUrl, mime_type: imageType, resolution: 'high' });
  return {
    model,
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema },
    // A page that turned the Worker away is opened by Google itself; its address is in the prompt.
    ...(pageUrl && { tools: [{ type: 'url_context' }] }),
    ...(background && { background: true }),
  };
}

// Google's URL tool reports each page it tried to open. When none opened, the model saw
// nothing of the page, and any other model would fare the same.
function refuseUnopenedPage(interaction) {
  const results = (Array.isArray(interaction?.steps) ? interaction.steps : [])
    .filter((step) => step?.type === 'url_context_result')
    .flatMap((step) => (Array.isArray(step.result) ? step.result : []));
  if (!results.some((result) => result?.status === 'success')) {
    throw new ImportError('source_blocked', { detail: `Gemini could not open the page either: ${JSON.stringify(results).slice(0, 300)}` });
  }
}

// How many tokens Google counted, and how many of the input were the image, for the log.
function usageLine(usage) {
  if (!usage) return 'no usage reported';
  const image = (usage.input_tokens_by_modality ?? []).find((entry) => entry?.modality === 'image')?.tokens;
  const imagePart = image === undefined ? '' : ` (image ${image})`;
  return `input tokens ${usage.total_input_tokens ?? '?'}${imagePart}, output tokens ${usage.total_output_tokens ?? '?'}`;
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

// Whether a rejected request with a video is about the model or the key, not the video:
// Google's message then names the model, the key, or the API being off for the project.
function aboutModelOrKey(status, text, model) {
  return status === 401 || text.includes(model) || /api[ _-]?key|SERVICE_DISABLED/i.test(text);
}

function failureFrom(status, text, { model, media }) {
  if (status === 429) return quotaErrorFrom(text);
  const detail = googleReason(status, text);
  if (status === 503) return new ModelBusyError(detail);
  // Cloudflare's own answer, not Google's: Google sent nothing back for about 100 s, the
  // longest Cloudflare waits. A slow model does that on most videos, and trying it again
  // would only wait again, so the request moves on to the next model, like a busy one.
  // Google still ran it, so it stays counted.
  if (status === 524) return new ModelBusyError(detail, { counted: true });
  // A rejected request won't get better by itself, so only a server error is tried again.
  if (status >= 500) return new ImportError('llm_error', { retryable: true, detail });
  // Without a video the request is only our prompt and schema, so a 4xx is about the model.
  // Google blocks an answer that would copy published text (e.g. a recipe site's page) as
  // "recitation". For a video that is one more refusal; a photo has nothing else to read.
  if (media && /recitation/i.test(text)) return new RecitationError();
  if (media && !aboutModelOrKey(status, text, model)) return new VideoRefusedError();
  return new ModelUnusableError(detail);
}

const headersFor = (env) => ({
  'Content-Type': 'application/json',
  'x-goog-api-key': env.GEMINI_API_KEY,
  'Api-Revision': API_REVISION,
});

// A request in Google's background mode answers at once with an id and keeps running at
// Google, so no connection has to stay open past Cloudflare's ~100 s (see 524 above). Its
// answer is then asked for, sooner at first and every 30 s after, which keeps a 14-minute
// wait to about 30 requests, under the Workers free plan's 50 per step.
const POLL_TIMEOUT_MS = 30 * 1000;

async function waitInBackground({ env, model, id, startedAt, pollMs }) {
  const url = `${ENDPOINT}/${encodeURIComponent(id)}`;
  for (let poll = 1; ; poll++) {
    if (Date.now() - startedAt > REQUEST_TIMEOUT_MS) {
      throw new ImportError('llm_error', { retryable: true, detail: `Gemini background request ${id} still running after ${REQUEST_TIMEOUT_MS / 60000} minutes` });
    }
    await sleep(Math.min(poll * pollMs, 6 * pollMs));
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS), headers: headersFor(env) });
    } catch (error) {
      throw new ImportError('llm_error', { retryable: true, detail: `Gemini background check failed: ${error.name}: ${error.message}` });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`LLM call failed: model=${model} background check status=${response.status}\n${text.slice(0, 2000)}`);
      // The video was already taken when the request started, so this is never about it.
      throw failureFrom(response.status, text, { model, media: null });
    }
    const interaction = await response.json().catch(() => null);
    if (interaction?.status !== 'in_progress') return interaction;
  }
}

// Sends one request and returns the model's answer as parsed JSON. Throws QuotaError,
// ModelBusyError, ModelUnusableError, VideoRefusedError, or ImportError (llm_error for other temporary
// problems, bad_result for an answer that can't be read). `videoUrl` is a YouTube link or
// an uploaded file's uri (then with `videoType`); `imageUrl` is an uploaded photo's uri,
// with `imageType`. `pageUrl` is a web page Google opens itself with its URL tool (throwing
// ImportError source_blocked when it can't). `background: true` runs it in Google's background mode (only the best
// model, models.js); `pollMs` is swapped in tests.
export async function callModel({ env, model, prompt, schema, videoUrl, videoType, imageUrl, imageType, pageUrl = null, background = false, pollMs = 5000 }) {
  // Sending nothing without a key: a mistake must never reach Google half-configured.
  if (!env.GEMINI_API_KEY) throw new ImportError('llm_error', { detail: 'GEMINI_API_KEY is not set' });

  // One line per real request, so a bad result can be traced to what the model was sent.
  // Never add the key or the headers. Every prompt is logged, the AI tools' too, which hold
  // the user's own recipe (the owner's choice, for debugging); logs are kept 3 days. A
  // user's photo is only logged by its type, never its uri.
  const media = imageUrl ? `image=${imageType}` : pageUrl ? `page=${pageUrl}` : `video=${videoUrl ?? 'none'}`;
  console.log(`LLM call: model=${model} ${media}\n${prompt}`);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: 'POST',
      headers: headersFor(env),
      body: JSON.stringify(requestBody({ model, prompt, schema, videoUrl, videoType, imageUrl, imageType, pageUrl, background })),
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
    throw failureFrom(response.status, text, { model, media: videoUrl || imageUrl });
  }

  let interaction = await response.json().catch(() => null);
  if (background && interaction?.status === 'in_progress') {
    if (!interaction.id) throw new ImportError('llm_error', { retryable: true, detail: 'Gemini background request answered without an id' });
    interaction = await waitInBackground({ env, model, id: interaction.id, startedAt, pollMs });
  }
  if (interaction?.status && interaction.status !== 'completed') {
    const detail = `Gemini answered with status ${interaction.status}`;
    console.log(`LLM call failed: model=${model} ${detail}`);
    throw new ImportError('llm_error', { retryable: true, detail });
  }
  console.log(`LLM answer: model=${model} in ${Date.now() - startedAt} ms${background ? ' (background)' : ''}, ${usageLine(interaction?.usage)}`);
  if (pageUrl) refuseUnopenedPage(interaction);
  return parseOutput(outputText(interaction));
}

// ---- Files the model can't read from a link ----
// Gemini reads a YouTube video from its link. Any other video, and a user's photo, has to
// be uploaded to its file store first (free, 2 GB a file, deleted by Google after 48
// hours), and the model is then given the file's uri.

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

// Uploads a file of `bytes` bytes from the stream `body`, without holding it in memory.
// Returns { name, uri, mimeType } to keep with the import. Google's upload takes two
// requests: one that says what is coming and answers with where to send it, then the bytes.
async function uploadFile({ env, body, bytes, mimeType }) {
  const startedAt = Date.now();
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
      body: JSON.stringify({ file: { display_name: mimeType.startsWith('image/') ? 'recipe photo' : 'recipe video' } }),
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
  console.log(`File uploaded to Gemini: ${file.name}, ${mimeType}, ${bytes} bytes, in ${Date.now() - startedAt} ms`);
  return { name: file.name, uri: file.uri, mimeType };
}

// Waits until Gemini has processed an uploaded file, which takes a few seconds. Throws
// FileGoneError when it is gone, VideoRefusedError when processing failed, and a retryable
// llm_error when it is still not ready, so the stage's own retries keep waiting.
async function waitUntilReady({ env, file, pollMs = FILE_POLL_MS }) {
  for (let poll = 1; ; poll++) {
    const response = await fileRequest(env, FILES_BASE + file.name, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, 'file check');
    if (response.status === 403 || response.status === 404) throw new FileGoneError();
    if (!response.ok) throw uploadFailed(`file check answered ${response.status}`);
    const { state } = await response.json();
    if (state === 'ACTIVE') return;
    if (state === 'FAILED') throw new VideoRefusedError();
    if (poll === FILE_POLLS) throw uploadFailed('the file is still being processed');
    await sleep(pollMs);
  }
}

// Deletes an uploaded file. A failure is only logged: Google deletes it after 48 hours anyway.
async function removeFile({ env, file }) {
  try {
    const response = await fileRequest(env, FILES_BASE + file.name, { method: 'DELETE', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, 'delete');
    if (!response.ok) console.log(`File not deleted from Gemini: ${file.name}, status ${response.status}`);
  } catch (error) {
    console.log(`File not deleted from Gemini: ${file.name}, ${error.detail ?? error.message}`);
  }
}

export const geminiFiles = { upload: uploadFile, waitUntilReady, remove: removeFile };
