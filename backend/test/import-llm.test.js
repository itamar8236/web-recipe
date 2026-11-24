import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callModel, ModelBusyError, ModelUnusableError, QuotaError, VideoRefusedError } from '../src/import/llm.js';

const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SCHEMA = { type: 'object' };

const respond = (body, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
const interaction = (text) => ({
  status: 'completed',
  steps: [
    { type: 'thought', content: [{ type: 'text', text: 'thinking...' }] },
    { type: 'model_output', content: [{ type: 'text', text }] },
  ],
});
const call = (extra = {}) => callModel({ env, model: 'some-model', prompt: 'the prompt', schema: SCHEMA, ...extra });
const sentBody = () => JSON.parse(fetch.mock.calls[0][1].body);
const quotaResponse = (details, status = 429) => respond({ error: { code: status, status: 'RESOURCE_EXHAUSTED', details } }, status);

// callModel logs every request; this keeps that out of the test output and lets tests read
// it. Held here because reading console.log in the Workers runtime gives a bound copy.
let log;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callModel: the request', () => {
  it('posts to the Interactions API with the key in a header, never in the URL', async () => {
    respond(interaction('{"status":"none"}'));
    await call();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(url).not.toContain('fake-gemini-key');
    expect(options.method).toBe('POST');
    expect(options.headers['x-goog-api-key']).toBe('fake-gemini-key');
  });

  it('asks for JSON matching the schema and gives the model no tools', async () => {
    respond(interaction('{"status":"none"}'));
    await call();
    const body = sentBody();
    expect(body.model).toBe('some-model');
    expect(body.response_format).toEqual({ type: 'text', mime_type: 'application/json', schema: SCHEMA });
    expect(body.tools).toBeUndefined();
  });

  it('puts the video before the text when it can be sent', async () => {
    respond(interaction('{"status":"none"}'));
    await call({ videoUrl: VIDEO });
    expect(sentBody().input).toEqual([
      { type: 'video', uri: VIDEO },
      { type: 'text', text: 'the prompt' },
    ]);
  });

  it('sends only the text when there is no video', async () => {
    respond(interaction('{"status":"none"}'));
    await call();
    expect(sentBody().input).toEqual([{ type: 'text', text: 'the prompt' }]);
  });

  it('gives the model its URL tool only for a page it must read itself', async () => {
    const opened = interaction('{"status":"none"}');
    opened.steps.unshift({ type: 'url_context_result', result: [{ url: 'https://recipes.example.co.il/salad/', status: 'success' }] });
    respond(opened);
    await call({ pageUrl: 'https://recipes.example.co.il/salad/' });
    expect(sentBody().tools).toEqual([{ type: 'url_context' }]);
    expect(sentBody().input).toEqual([{ type: 'text', text: 'the prompt' }]);
  });

  it.each([[undefined], ['']])('sends nothing when the key is %j', async (key) => {
    respond(interaction('{"status":"none"}'));
    const error = await callModel({ env: { ...env, GEMINI_API_KEY: key }, model: 'm', prompt: 'p', schema: SCHEMA }).catch((e) => e);
    expect(error).toMatchObject({ code: 'llm_error', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('callModel: logging', () => {
  const logged = () => log.mock.calls.map((args) => args.join(' ')).join('\n');

  it('logs the model, the video and the full prompt once, then how long the answer took, and never the key', async () => {
    respond(interaction('{"status":"none"}'));
    await call({ videoUrl: VIDEO });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toMatch(/^LLM answer: model=some-model in \d+ ms, no usage reported$/);
    expect(logged()).toContain('some-model');
    expect(logged()).toContain(VIDEO);
    expect(logged()).toContain('the prompt');
    expect(logged()).not.toContain('fake-gemini-key');
  });

  it('says when no video was sent', async () => {
    respond(interaction('{"status":"none"}'));
    await call();
    expect(logged()).toContain('video=none');
  });

  it('logs nothing when no request is sent', async () => {
    await callModel({ env: { ...env, GEMINI_API_KEY: '' }, model: 'm', prompt: 'p', schema: SCHEMA }).catch(() => {});
    expect(log).not.toHaveBeenCalled();
  });
});

describe('callModel: reading the answer', () => {
  it('returns the parsed JSON from the model_output step, skipping thoughts', async () => {
    respond(interaction('{"status":"one","language":"he"}'));
    expect(await call()).toEqual({ status: 'one', language: 'he' });
  });

  it('says the page is blocked when Google could not open it either', async () => {
    const PAGE = 'https://recipes.example.co.il/salad/';
    respond({
      status: 'completed',
      steps: [
        { type: 'url_context_call', arguments: { urls: [PAGE] } },
        { type: 'url_context_result', result: [{ url: PAGE, status: 'error' }], is_error: false },
        { type: 'model_output', content: [{ type: 'text', text: '{"status":"none"}' }] },
      ],
    });
    await expect(call({ pageUrl: PAGE })).rejects.toMatchObject({ code: 'source_blocked', retryable: false });
  });

  it('reads the answer when Google opened the page', async () => {
    const PAGE = 'https://recipes.example.co.il/salad/';
    respond({
      status: 'completed',
      steps: [
        { type: 'url_context_result', result: [{ url: PAGE, status: 'success' }] },
        { type: 'model_output', content: [{ type: 'text', text: '{"status":"one"}' }] },
      ],
    });
    expect(await call({ pageUrl: PAGE })).toEqual({ status: 'one' });
  });

  it('refuses an answer when the model never opened the page, so it can’t answer from memory', async () => {
    respond(interaction('{"status":"one"}'));
    await expect(call({ pageUrl: 'https://recipes.example.co.il/salad/' })).rejects.toMatchObject({ code: 'source_blocked' });
  });

  it('joins output split over several text parts', async () => {
    respond({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"status":' }, { type: 'text', text: '"none"}' }] }],
    });
    expect(await call()).toEqual({ status: 'none' });
  });

  it.each(['```json\n{"status":"none"}\n```', '```\n{"status":"none"}\n```', '  {"status":"none"}  '])('reads %j despite the wrapping', async (text) => {
    respond(interaction(text));
    expect(await call()).toEqual({ status: 'none' });
  });

  it.each([
    ['not JSON', interaction('here is your recipe')],
    ['JSON that is not an object', interaction('[1, 2]')],
    ['no output at all', { status: 'completed', steps: [] }],
    ['no steps', { status: 'completed' }],
  ])('fails with a retryable bad_result on %s', async (_, body) => {
    respond(body);
    await expect(call()).rejects.toMatchObject({ code: 'bad_result', retryable: true });
  });

  it.each(['failed', 'incomplete', 'cancelled'])('treats an interaction that is %s as temporary', async (status) => {
    respond({ status, steps: [] });
    await expect(call()).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });
});

describe('callModel: failures', () => {
  it.each([500, 502, 504])('treats %i as temporary', async (status) => {
    respond({ error: {} }, status);
    await expect(call({ videoUrl: VIDEO })).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });

  it('reports a 503 as the model being busy, with Google’s reason', async () => {
    respond({ error: { message: 'This model is currently experiencing high demand.' } }, 503);
    const error = await call({ videoUrl: VIDEO }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelBusyError);
    expect(error.detail).toBe('Gemini 503: This model is currently experiencing high demand.');
  });

  // Cloudflare's answer when Google sent nothing back for about 100 s, as plain text.
  it('reports a 524 as the model being busy, but counted, so the next model is tried', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error code: 524', { status: 524 })));
    const error = await call({ videoUrl: VIDEO }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelBusyError);
    expect(error).toMatchObject({ counted: true, detail: 'Gemini 524: error code: 524' });
  });

  it('does not mark a 503 as counted', async () => {
    respond({ error: { message: 'high demand' } }, 503);
    expect(await call().catch((e) => e)).toMatchObject({ counted: false });
  });

  it('gives up on a request that takes too long, so a retry never overlaps it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    await expect(call({ videoUrl: VIDEO })).rejects.toMatchObject({ code: 'llm_error', retryable: true });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(log.mock.calls.at(-1).join(' ')).toContain('TimeoutError');
  });

  it('logs the status and Google’s error text when a call fails', async () => {
    respond({ error: { message: 'The model is overloaded.' } }, 503);
    await call().catch(() => {});
    const line = log.mock.calls.at(-1).join(' ');
    expect(line).toContain('status=503');
    expect(line).toContain('The model is overloaded.');
    expect(line).not.toContain('fake-gemini-key');
  });

  it('gives the failure a short reason to keep on the import', async () => {
    respond({ error: { message: 'The model is overloaded.' } }, 503);
    expect(await call().catch((e) => e)).toMatchObject({ detail: 'Gemini 503: The model is overloaded.' });
  });

  it('treats a network failure as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(call()).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });

  it('reports a non-quota 4xx on a call with a video as the video being refused', async () => {
    respond({ error: { code: 400, message: 'Request contains an invalid argument.' } }, 400);
    await expect(call({ videoUrl: VIDEO })).rejects.toBeInstanceOf(VideoRefusedError);
  });

  it.each([400, 401, 403, 404])('reports a %i on a text-only call as the model being unusable, with Google’s reason', async (status) => {
    respond({ error: { code: status, message: 'Something is wrong.' } }, status);
    const error = await call().catch((e) => e);
    expect(error).toBeInstanceOf(ModelUnusableError);
    expect(error.detail).toBe(`Gemini ${status}: Something is wrong.`);
  });

  it.each([
    ['a model that is gone', 404, 'models/some-model is not found for API version v1beta.'],
    ['a key Google does not take', 400, 'API key not valid. Please pass a valid API key.'],
    ['a key that is not allowed', 403, 'Method doesn’t allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.'],
    ['an unauthenticated call', 401, 'Request had invalid authentication credentials.'],
    ['the API turned off for the project', 403, 'Generative Language API has not been used in project 123 before or it is disabled. SERVICE_DISABLED'],
  ])('reports %s on a call with a video as the model being unusable, not the video', async (_, status, message) => {
    respond({ error: { code: status, message } }, status);
    await expect(call({ videoUrl: VIDEO })).rejects.toBeInstanceOf(ModelUnusableError);
  });
});

describe('callModel: 429', () => {
  const quotaFailure = (violation) => ({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [violation] });
  const retryInfo = (retryDelay) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay });
  const quotaError = () => call().catch((e) => e);

  it('recognises a daily limit from its quotaId', async () => {
    quotaResponse([quotaFailure({ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' })]);
    const error = await quotaError();
    expect(error).toBeInstanceOf(QuotaError);
    expect(error.daily).toBe(true);
  });

  it('recognises a daily limit named elsewhere in a violation', async () => {
    quotaResponse([quotaFailure({ quotaMetric: 'generativelanguage.googleapis.com/generate_requests_PerDay' })]);
    expect((await quotaError()).daily).toBe(true);
  });

  // The shape Google answered with in production from 2026-11, with no details at all.
  it('recognises a daily limit named only in the message', async () => {
    const message =
      'Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 10h46m37s or upgrade your tier at https://ai.dev/rate-limit.';
    respond({ error: { message, code: 'too_many_requests' } }, 429);
    expect((await quotaError()).daily).toBe(true);
  });

  it('does not call a per-minute limit named only in the message daily', async () => {
    respond({ error: { message: 'Rate limit exceeded for model gemini-3.8-flash (limit: 5 requests per minute on Free Tier).', code: 'too_many_requests' } }, 429);
    expect((await quotaError()).daily).toBe(false);
  });

  it('does not call a per-minute limit daily', async () => {
    quotaResponse([quotaFailure({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' })]);
    expect((await quotaError()).daily).toBe(false);
  });

  it('treats a bare 429 as not daily, waiting 20 seconds', async () => {
    respond({}, 429);
    const error = await quotaError();
    expect(error).toBeInstanceOf(QuotaError);
    expect(error.daily).toBe(false);
    expect(error.retryDelayMs).toBe(20000);
  });

  it('survives a 429 whose body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    expect(await quotaError()).toMatchObject({ daily: false, retryDelayMs: 20000 });
  });

  it('uses the retry delay Google gives', async () => {
    quotaResponse([retryInfo('34.5s')]);
    expect((await quotaError()).retryDelayMs).toBe(34500);
  });

  it('caps the retry delay at 60 seconds', async () => {
    quotaResponse([retryInfo('3600s')]);
    expect((await quotaError()).retryDelayMs).toBe(60000);
  });

  it('is still a quota error, not a video refusal, on a call with a video', async () => {
    respond({}, 429);
    await expect(call({ videoUrl: VIDEO })).rejects.toBeInstanceOf(QuotaError);
  });
});

describe('callModel: background mode', () => {
  const running = { id: 'v1_abc', status: 'in_progress' };
  // Answers the POST with `first`, then each check with the next of `checks`.
  const google = (first, ...checks) => {
    const queue = [...checks];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options = {}) => {
        const body = options.method === 'POST' ? first : queue.length > 1 ? queue.shift() : queue[0];
        return body instanceof Response ? body : new Response(JSON.stringify(body));
      }),
    );
  };
  const background = (extra = {}) => call({ videoUrl: VIDEO, background: true, pollMs: 1, ...extra });

  it('is off unless asked for', async () => {
    respond(interaction('{"status":"none"}'));
    await call();
    expect(sentBody()).not.toHaveProperty('background');
  });

  it('asks for it, then checks the request by its id until it is done, and reads the answer', async () => {
    google(running, running, running, { ...interaction('{"status":"one"}'), id: 'v1_abc' });
    expect(await background()).toEqual({ status: 'one' });
    expect(sentBody()).toMatchObject({ background: true, model: 'some-model' });
    const checks = fetch.mock.calls.slice(1);
    expect(checks).toHaveLength(3);
    for (const [url, options] of checks) {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc');
      expect(options.method).toBeUndefined();
      expect(options.headers['x-goog-api-key']).toBe('fake-gemini-key');
    }
    expect(log.mock.calls.at(-1)[0]).toMatch(/^LLM answer: model=some-model in \d+ ms \(background\), no usage reported$/);
  });

  it('reads an answer that is done at once, with no check', async () => {
    google(interaction('{"status":"none"}'));
    expect(await background()).toEqual({ status: 'none' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a request that failed at Google as temporary', async () => {
    google(running, { id: 'v1_abc', status: 'failed' });
    await expect(background()).rejects.toMatchObject({ code: 'llm_error', retryable: true, detail: 'Gemini answered with status failed' });
  });

  it('logs Google’s reasons for a failed request', async () => {
    google(running, { id: 'v1_abc', status: 'failed', errors: [{ message: 'Internal', code: 'INTERNAL' }] });
    await expect(background()).rejects.toMatchObject({ code: 'llm_error', retryable: true, detail: 'Gemini answered with status failed: [{"message":"Internal","code":"INTERNAL"}]' });
  });

  // What Google really answered (2026-11-23) when the best model's quota was used up.
  it('reads a request that failed with RESOURCE_EXHAUSTED as a short quota limit', async () => {
    const exhausted = { message: 'There was a problem processing your request. You will only be charged for tokens successfully generated.', code: 'RESOURCE_EXHAUSTED' };
    google(running, { id: 'v1_abc', status: 'failed', steps: [], errors: [exhausted] });
    const error = await background().catch((e) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error.daily).toBe(false);
  });

  it('treats a failed check like any failed call', async () => {
    google(running, new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 }));
    await expect(background()).rejects.toBeInstanceOf(ModelBusyError);
  });

  it('fails as temporary when the start has no id to check', async () => {
    google({ status: 'in_progress' });
    await expect(background()).rejects.toMatchObject({ code: 'llm_error', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits longer between checks, up to six times the first wait', async () => {
    const waits = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      waits.push(ms);
      fn();
      return 0;
    });
    google(running, running, running, running, running, running, running, running, interaction('{"status":"none"}'));
    await background({ pollMs: 10 });
    expect(waits.filter((ms) => ms <= 60)).toEqual([10, 20, 30, 40, 50, 60, 60, 60]);
  });
});
