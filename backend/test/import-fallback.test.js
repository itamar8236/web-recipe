// The fallback model: a text-only model from another provider (Groq) that answers when
// every Gemini model in line is busy or out. Off until GROQ_API_KEY is set.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callFallbackModel } from '../src/import/groq.js';
import { ModelBusyError, QuotaError } from '../src/import/llm.js';
import { callChosenModel, quotaDay } from '../src/import/models.js';
import { handleTranslate } from '../src/translate.js';
import { insertImport, insertUser } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
const IMPORT = env.LLM_IMPORT_MODELS.split(',');
const LIMITS = Object.fromEntries(env.LLM_DAILY_LIMITS.split(',').map((item) => [item.slice(0, item.lastIndexOf(':')), Number(item.slice(item.lastIndexOf(':') + 1))]));
const FALLBACK = env.LLM_FALLBACK_MODEL;
const withKey = { ...env, GROQ_API_KEY: 'fake-groq-key' };
const today = () => quotaDay(Date.now());
const ANSWER = { status: 'none' };
const busy = () => new ModelBusyError('Gemini 503: high demand');

// Held here because reading console.log in the Workers runtime gives a bound copy.
let log;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const answering = (...results) => {
  const queue = [...results];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
};
const usage = async (model) =>
  (await env.DB.prepare('SELECT calls FROM llm_usage WHERE day = ? AND model = ?').bind(today(), model).first())?.calls ?? 0;
const markOut = (model) => env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, ?)').bind(today(), model, LIMITS[model]).run();
const markImportModelsOut = async () => {
  for (const model of IMPORT) await markOut(model);
};
const newJob = async (state = {}) => ({ ...(await insertImport(await insertUser(), { quota_day: today() })), state });
const ask = (job, deps, request = {}) => callChosenModel(job, deps, { prompt: 'p', schema: {}, videoUrl: null, ...request });

describe('the fallback model in the model policy', () => {
  it('is set in the config, with its own daily limit', () => {
    expect(FALLBACK).toBe('openai/gpt-oss-120b');
    expect(LIMITS[FALLBACK]).toBeGreaterThan(0);
    expect(env.GROQ_API_KEY).toBe('');
  });

  it('is never called without its key: busy models stay busy', async () => {
    const fallbackLlm = answering(ANSWER);
    await expect(ask(await newJob(), { env, llm: answering(busy()), fallbackLlm })).rejects.toBeInstanceOf(ModelBusyError);
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('is never called without its key: every Gemini model out is still quota', async () => {
    await markImportModelsOut();
    const fallbackLlm = answering(ANSWER);
    await expect(ask(await newJob(), { env, llm: answering(ANSWER), fallbackLlm })).rejects.toMatchObject({ code: 'quota' });
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('answers a text request when every import model is busy, and is counted on its own', async () => {
    const fallbackLlm = answering(ANSWER);
    const result = await ask(await newJob(), { env: withKey, llm: answering(busy()), fallbackLlm });
    expect(result).toEqual({ output: ANSWER, model: FALLBACK });
    expect(fallbackLlm).toHaveBeenCalledTimes(1);
    expect(fallbackLlm.mock.calls[0][0]).toMatchObject({ model: FALLBACK, prompt: 'p' });
    expect(await usage(FALLBACK)).toBe(1);
    for (const model of IMPORT) expect(await usage(model)).toBe(0);
  });

  it('answers when every import model is out for the day', async () => {
    await markImportModelsOut();
    const llm = answering(ANSWER);
    const result = await ask(await newJob(), { env: withKey, llm, fallbackLlm: answering(ANSWER) });
    expect(result.model).toBe(FALLBACK);
    expect(llm).not.toHaveBeenCalled();
  });

  it('answers after the best model the user asked for is out and the rest are busy, keeping the best-model use', async () => {
    const job = await newJob({ bestChosen: true });
    const llm = answering(new QuotaError({ daily: true, retryDelayMs: 1 }), busy());
    const result = await ask(job, { env: withKey, llm, fallbackLlm: answering(ANSWER) });
    expect(result.model).toBe(FALLBACK);
    expect(llm.mock.calls.map(([args]) => args.model)).toEqual([BEST, ...IMPORT]);
    expect((await env.DB.prepare('SELECT used_best FROM llm_requests WHERE id = ?').bind(job.id).first()).used_best).toBe(1);
  });

  it('is never given a video: that request waits for Gemini as before', async () => {
    const fallbackLlm = answering(ANSWER);
    const request = { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
    await expect(ask(await newJob(), { env: withKey, llm: answering(busy()), fallbackLlm }, request)).rejects.toBeInstanceOf(ModelBusyError);
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('reports the first busy model when the fallback is busy too', async () => {
    const error = await ask(await newJob(), { env: withKey, llm: answering(busy()), fallbackLlm: answering(new ModelBusyError('Groq 503')) }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelBusyError);
    expect(error.detail).toBe('Gemini 503: high demand');
    expect(await usage(FALLBACK)).toBe(0);
  });

  it('fails with quota when every import model is out and the fallback has reached its limit', async () => {
    await markImportModelsOut();
    await markOut(FALLBACK);
    const fallbackLlm = answering(ANSWER);
    await expect(ask(await newJob(), { env: withKey, llm: answering(ANSWER), fallbackLlm })).rejects.toMatchObject({ code: 'quota' });
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('is not used while an import model answers', async () => {
    const fallbackLlm = answering(ANSWER);
    expect((await ask(await newJob(), { env: withKey, llm: answering(busy(), busy(), ANSWER), fallbackLlm })).model).toBe(IMPORT[2]);
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('passes on its own failures, such as an answer that cannot be read', async () => {
    const { ImportError } = await import('../src/import/errors.js');
    const fallbackLlm = answering(new ImportError('bad_result', { retryable: true }));
    await expect(ask(await newJob(), { env: withKey, llm: answering(busy()), fallbackLlm })).rejects.toMatchObject({ code: 'bad_result' });
  });
});

describe('translation with the fallback model', () => {
  const SOURCE = { name: 'Tea', ingredients: ['1 cup water'], steps: ['Boil the water'] };
  const HEBREW = { name: 'תה', ingredients: ['כוס מים'], steps: ['מרתיחים את המים'] };
  const groqReply = (output, status = 200, headers = {}) =>
    new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify(output) } }] } : output), { status, headers });
  const translate = async (testEnv, llm) =>
    handleTranslate(
      new Request('http://localhost/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'en', content: SOURCE }) }),
      testEnv,
      '/api/translate',
      await insertUser(),
      llm,
    );

  it('answers through Groq when the translation model is busy, and records which model answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => groqReply(HEBREW)));
    const response = await translate(withKey, answering(busy()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: HEBREW });
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.groq.com/openai/v1/chat/completions');
    const row = await env.DB.prepare(`SELECT * FROM llm_requests WHERE purpose = 'translation'`).first();
    expect(row.model).toBe(FALLBACK);
  });

  it('still answers 503 model_busy without the key, sending nothing to Groq', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => groqReply(HEBREW)));
    const response = await translate(env, answering(busy()));
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('callFallbackModel: Groq’s request format', () => {
  const SCHEMA = { type: 'object' };
  const reply = (content, status = 200, headers = {}) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : content), { status, headers })));
  const call = (extra = {}) => callFallbackModel({ env: withKey, model: FALLBACK, prompt: 'the prompt', schema: SCHEMA, ...extra });

  it('posts the prompt and the schema with the key in a header, never in the URL', async () => {
    reply('{"status":"none"}');
    expect(await call()).toEqual({ status: 'none' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(options.headers.Authorization).toBe('Bearer fake-groq-key');
    expect(JSON.parse(options.body)).toEqual({
      model: FALLBACK,
      messages: [{ role: 'user', content: 'the prompt' }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: SCHEMA } },
    });
  });

  it('logs the prompt but never the key, and not a prompt that holds the user’s text', async () => {
    reply('{}');
    await call();
    await call({ logPrompt: false });
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('the prompt');
    expect(logged).toContain('(prompt not logged: user text)');
    expect(logged).not.toContain('fake-groq-key');
  });

  it.each([[undefined], ['']])('sends nothing when the key is %j', async (key) => {
    reply('{}');
    const error = await callFallbackModel({ env: { ...env, GROQ_API_KEY: key }, model: FALLBACK, prompt: 'p', schema: SCHEMA }).catch((e) => e);
    expect(error).toMatchObject({ code: 'llm_error', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a 429 into a short quota error with Groq’s own delay, capped at a minute', async () => {
    reply({ error: {} }, 429, { 'retry-after': '18' });
    expect(await call().catch((e) => e)).toMatchObject({ name: 'QuotaError', daily: false, retryDelayMs: 18000 });
    reply({ error: {} }, 429, { 'retry-after': '900' });
    expect(await call().catch((e) => e)).toMatchObject({ retryDelayMs: 60000 });
    reply({ error: {} }, 429);
    expect(await call().catch((e) => e)).toMatchObject({ retryDelayMs: 20000 });
  });

  it('turns a 503 into a busy error', async () => {
    reply({ error: {} }, 503);
    await expect(call()).rejects.toBeInstanceOf(ModelBusyError);
  });

  it.each([
    ['JSON the model could not fit to the schema', { error: { code: 'json_validate_failed' } }, 400, { code: 'bad_result', retryable: true }],
    ['another rejected request', { error: { message: 'model not found' } }, 404, { code: 'llm_error', retryable: false }],
    ['a server error', { error: {} }, 500, { code: 'llm_error', retryable: true }],
  ])('fails on %s', async (_, body, status, expected) => {
    reply(body, status);
    expect(await call().catch((e) => e)).toMatchObject(expected);
  });

  it.each(['not json', '[1,2]', '"text"', ''])('fails with a retryable bad_result on the answer %j', async (content) => {
    reply(content);
    expect(await call().catch((e) => e)).toMatchObject({ code: 'bad_result', retryable: true });
  });

  it('treats a network failure as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
    expect(await call().catch((e) => e)).toMatchObject({ code: 'llm_error', retryable: true });
  });
});
