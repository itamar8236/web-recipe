import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callModel, QuotaError, VideoRefusedError } from '../src/import/llm.js';

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

afterEach(() => vi.unstubAllGlobals());

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

  it.each([[undefined], ['']])('sends nothing when the key is %j', async (key) => {
    respond(interaction('{"status":"none"}'));
    const error = await callModel({ env: { ...env, GEMINI_API_KEY: key }, model: 'm', prompt: 'p', schema: SCHEMA }).catch((e) => e);
    expect(error).toMatchObject({ code: 'llm_error', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('callModel: reading the answer', () => {
  it('returns the parsed JSON from the model_output step, skipping thoughts', async () => {
    respond(interaction('{"status":"one","language":"he"}'));
    expect(await call()).toEqual({ status: 'one', language: 'he' });
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
  it.each([500, 503])('treats %i as temporary', async (status) => {
    respond({ error: {} }, status);
    await expect(call({ videoUrl: VIDEO })).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });

  it('treats a network failure as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(call()).rejects.toMatchObject({ code: 'llm_error', retryable: true });
  });

  it('reports a non-quota 4xx on a call with a video as the video being refused', async () => {
    respond({ error: { code: 400 } }, 400);
    await expect(call({ videoUrl: VIDEO })).rejects.toBeInstanceOf(VideoRefusedError);
  });

  it('does not retry a non-quota 4xx on a text-only call', async () => {
    respond({ error: { code: 400 } }, 400);
    await expect(call()).rejects.toMatchObject({ code: 'llm_error', retryable: false });
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
