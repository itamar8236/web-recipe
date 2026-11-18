// Imports from a photo: the endpoint that takes the picture, the stages that read it, the
// Workflow end to end, and how a photo recipe looks in the API.

import { env, introspectWorkflow } from 'cloudflare:test';
import { NonRetryableError } from 'cloudflare:workflows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { callModel, FileGoneError, ModelBusyError, RecitationError, VideoRefusedError } from '../src/import/llm.js';
import { quotaDay } from '../src/import/models.js';
import { readLink, sourceFor } from '../src/import/sources/index.js';
import { runStage, STAGES } from '../src/import/stages.js';
import worker from '../src/index.js';
import { call, cookiesFrom, insertImport, insertUser, register } from './helpers.js';

const BEST = env.LLM_BEST_MODEL;
const IMPORT_MODELS = env.LLM_IMPORT_MODELS.split(',');
const PHOTO_ID = '0123456789abcdef0123456789abcdef';
const PHOTO_URL = `photo:${PHOTO_ID}`;
const FILE = { name: 'files/pic123', uri: 'https://generativelanguage.googleapis.com/v1beta/files/pic123', mimeType: 'image/jpeg' };
const today = () => quotaDay(Date.now());
const stage = (name) => STAGES.find((s) => s.name === name);

const ONE = {
  status: 'one',
  language: 'he',
  en: { name: 'Asado', ingredients: ['2 kg asado'], steps: ['Bake for 4 hours'] },
  he: { name: 'אסאדו', ingredients: ['2 קילו אסאדו'], steps: ['לאפות 4 שעות'] },
};
const EMPTY = { name: '', ingredients: [], steps: [] };
const NONE = { status: 'none', language: 'other', en: EMPTY, he: EMPTY };

let log;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fakeFiles = (overrides = {}) => ({
  upload: vi.fn(async () => FILE),
  waitUntilReady: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  ...overrides,
});
const fakeLlm = (...answers) => {
  const queue = [...answers];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
};
const reload = (row) => env.DB.prepare('SELECT * FROM llm_requests WHERE id = ?').bind(row.id).first();
const markOut = (model) => env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, 100000)').bind(today(), model).run();
const photoRow = (userId, fields = {}) =>
  insertImport(userId, {
    platform: 'photo',
    source_id: PHOTO_ID,
    source_url: PHOTO_URL,
    quota_day: today(),
    state: JSON.stringify({ photo: FILE, bestChosen: true }),
    ...fields,
  });
const atExtract = (userId, fields = {}) =>
  photoRow(userId, {
    stage: 'extract',
    state: JSON.stringify({ photo: FILE, bestChosen: true, meta: { text: '', transcript: '', video: null }, done: ['meta', 'video'], version: 2 }),
    ...fields,
  });
const expectFailure = async (promise, row, code, { retryable = false } = {}) => {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof NonRetryableError).toBe(!retryable);
  expect((await reload(row)).error).toBe(code);
};

describe('the photo source', () => {
  it('is never read from pasted text, so photo:<id> is no link', () => {
    expect(readLink(PHOTO_URL)).toEqual({ error: 'link_invalid' });
    expect(readLink(`https://example.com/${PHOTO_URL}`).source.platform).toBe('web');
  });

  it('is found by its platform, and has nothing to fetch', async () => {
    const source = sourceFor('photo');
    expect(await source.fetchPost(PHOTO_ID)).toEqual({ sourceId: PHOTO_ID, sourceUrl: PHOTO_URL, title: null, text: '', transcript: '', video: null });
  });
});

describe('callModel with a photo', () => {
  const respond = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"status":"none"}' }] }], usage: { total_input_tokens: 1300, total_output_tokens: 20, input_tokens_by_modality: [{ modality: 'image', tokens: 1100 }] } }))),
    );

  it('sends the picture at high resolution before the text', async () => {
    respond();
    await callModel({ env, model: 'm', prompt: 'p', schema: {}, imageUrl: FILE.uri, imageType: 'image/jpeg' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).input).toEqual([
      { type: 'image', uri: FILE.uri, mime_type: 'image/jpeg', resolution: 'high' },
      { type: 'text', text: 'p' },
    ]);
  });

  it('logs the picture’s type and the tokens it took, never its address', async () => {
    respond();
    await callModel({ env, model: 'm', prompt: 'p', schema: {}, imageUrl: FILE.uri, imageType: 'image/jpeg' });
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('image=image/jpeg');
    expect(logged).toContain('input tokens 1300 (image 1100), output tokens 20');
    expect(logged).not.toContain(FILE.uri);
  });

  it('reads a refusal that is not about the model or key as a refused picture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Unable to process input image' } }), { status: 400 })));
    const error = await callModel({ env, model: 'some-model', prompt: 'p', schema: {}, imageUrl: FILE.uri, imageType: 'image/jpeg' }).catch((e) => e);
    expect(error).toBeInstanceOf(VideoRefusedError);
  });

  it('tells Google’s copyright block apart, with the answer Google really gave', async () => {
    const blocked = { error: { message: 'Request blocked due to copyright/recitation content. Please modify your input and retry.', code: 'recitation' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(blocked), { status: 400 })));
    const error = await callModel({ env, model: 'some-model', prompt: 'p', schema: {}, imageUrl: FILE.uri, imageType: 'image/jpeg' }).catch((e) => e);
    expect(error).toBeInstanceOf(RecitationError);
    // So a video blocked this way still falls back to its text, as any refused video does.
    expect(error).toBeInstanceOf(VideoRefusedError);
  });
});

describe('stages for a photo', () => {
  it('meta fetches nothing and moves on, keeping the photo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nothing should be fetched'); }));
    const row = await photoRow(await insertUser());
    await runStage(env, row.id, row.attempt, stage('meta'));
    await runStage(env, row.id, row.attempt, stage('video'), { files: fakeFiles() });
    const after = await reload(row);
    expect(after).toMatchObject({ stage: 'extract', status: 'running', title: null, source_url: PHOTO_URL, error: null });
    expect(JSON.parse(after.state)).toMatchObject({ photo: FILE, bestChosen: true, done: ['meta', 'video'] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the picture and the photo prompt, with no text or video, to the best model first', async () => {
    const row = await atExtract(await insertUser());
    const llm = fakeLlm(ONE);
    const files = fakeFiles();
    await runStage(env, row.id, row.attempt, stage('extract'), { llm, files });

    expect(files.waitUntilReady).toHaveBeenCalledWith({ env, file: FILE });
    expect(llm).toHaveBeenCalledTimes(1);
    const [args] = llm.mock.calls[0];
    expect(args).toMatchObject({ model: BEST, imageUrl: FILE.uri, imageType: 'image/jpeg' });
    expect(args.videoUrl).toBeUndefined();
    expect(args.prompt).toContain('handwritten recipe card');
    expect(args.prompt).toContain('never guess a recipe from how the food looks');
    expect(args.prompt).not.toContain('<description>');
    const after = await reload(row);
    expect(after).toMatchObject({ stage: 'save', used_best: 1, model: BEST });
    // The file is deleted by the save stage, not before.
    expect(files.remove).not.toHaveBeenCalled();
  });

  it('goes on with the import models by itself when the best model is out', async () => {
    await markOut(BEST);
    const row = await atExtract(await insertUser());
    const llm = fakeLlm(ONE);
    await runStage(env, row.id, row.attempt, stage('extract'), { llm, files: fakeFiles() });
    expect(llm.mock.calls[0][0].model).toBe(IMPORT_MODELS[0]);
    expect(await reload(row)).toMatchObject({ used_best: 0, model: IMPORT_MODELS[0] });
  });

  it('goes on with the import models when the user used their 5', async () => {
    const userId = await insertUser();
    for (let i = 0; i < 5; i++) await insertImport(userId, { source_id: `v${i}`, status: 'done', used_best: 1, quota_day: today() });
    const row = await atExtract(userId);
    const llm = fakeLlm(ONE);
    await runStage(env, row.id, row.attempt, stage('extract'), { llm, files: fakeFiles() });
    expect(llm.mock.calls[0][0].model).toBe(IMPORT_MODELS[0]);
  });

  it('never ends on the text-only fallback model', async () => {
    const row = await atExtract(await insertUser());
    const llm = fakeLlm(new ModelBusyError('busy'));
    const fallbackLlm = fakeLlm(ONE);
    const result = await runStage({ ...env, GROQ_API_KEY: 'fake-groq-key' }, row.id, row.attempt, stage('extract'), { llm, fallbackLlm, files: fakeFiles() });
    expect(result).toEqual({ busy: true });
    expect(fallbackLlm).not.toHaveBeenCalled();
  });

  it('fails photo_unreadable, for good, when Gemini refuses the picture, and deletes it', async () => {
    const row = await atExtract(await insertUser());
    const files = fakeFiles();
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm: fakeLlm(new VideoRefusedError()), files }), row, 'photo_unreadable');
    expect(files.remove).toHaveBeenCalledWith({ env, file: FILE });
  });

  it('fails photo_copyrighted, for good, when Google won’t copy a published recipe, and deletes it', async () => {
    const row = await atExtract(await insertUser());
    const files = fakeFiles();
    const llm = fakeLlm(new RecitationError());
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm, files }), row, 'photo_copyrighted');
    expect(llm).toHaveBeenCalledTimes(1);
    expect(files.remove).toHaveBeenCalledWith({ env, file: FILE });
  });

  it('fails photo_unreadable when Gemini could not process the file', async () => {
    const row = await atExtract(await insertUser());
    const llm = fakeLlm(ONE);
    const files = fakeFiles({ waitUntilReady: vi.fn(async () => { throw new VideoRefusedError(); }) });
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm, files }), row, 'photo_unreadable');
    expect(llm).not.toHaveBeenCalled();
  });

  it('fails photo_expired, for good, when the file is gone from Gemini’s store', async () => {
    const row = await atExtract(await insertUser());
    const llm = fakeLlm(ONE);
    const files = fakeFiles({ waitUntilReady: vi.fn(async () => { throw new FileGoneError(); }) });
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm, files }), row, 'photo_expired');
    expect(llm).not.toHaveBeenCalled();
  });

  it('leaves a file still being processed to the Workflow retries', async () => {
    const row = await atExtract(await insertUser());
    const files = fakeFiles({ waitUntilReady: vi.fn(async () => { throw new ImportError('llm_error', { retryable: true }); }) });
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm: fakeLlm(ONE), files }), row, 'llm_error', { retryable: true });
  });

  it.each([
    [NONE, 'no_recipe'],
    [{ ...NONE, status: 'multiple' }, 'multiple_recipes'],
  ])('ends with %s.status, deleting the picture', async (answer, code) => {
    const row = await atExtract(await insertUser());
    const files = fakeFiles();
    await expectFailure(runStage(env, row.id, row.attempt, stage('extract'), { llm: fakeLlm(answer), files }), row, code);
    expect(files.remove).toHaveBeenCalledWith({ env, file: FILE });
  });

  it('saves a photo recipe with its photo:<id> source, then deletes the picture', async () => {
    const userId = await insertUser();
    const row = await photoRow(userId, {
      stage: 'save',
      state: JSON.stringify({ photo: FILE, bestChosen: true, recipe: { language: 'he', en: ONE.en, he: ONE.he, calories: 700, protein: 50 }, model: BEST, done: ['meta', 'video', 'extract'], version: 2 }),
    });
    const files = fakeFiles();
    await runStage(env, row.id, row.attempt, stage('save'), { files });
    const recipe = await env.DB.prepare('SELECT * FROM recipes').first();
    expect(recipe).toMatchObject({ user_id: userId, platform: 'photo', source_url: PHOTO_URL, source_model: BEST, name_he: 'אסאדו', calories: 700 });
    expect(await reload(row)).toMatchObject({ status: 'done', state: '{}', recipe_id: recipe.id });
    expect(files.remove).toHaveBeenCalledWith({ env, file: FILE });
  });

  it('keeps the photo when older state is dropped', async () => {
    const row = await photoRow(await insertUser(), { stage: 'extract', state: JSON.stringify({ photo: FILE, bestChosen: true, done: ['meta', 'video'], version: 1 }) });
    await runStage(env, row.id, row.attempt, stage('meta'));
    expect(JSON.parse((await reload(row)).state)).toMatchObject({ photo: FILE, bestChosen: true, done: ['meta'], version: 2 });
  });
});

describe('the Workflow, end to end, for a photo', () => {
  const geminiReply = (output) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(output) }] }] });

  it('reads the picture with the best model, saves the recipe and deletes the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const address = String(url);
        if (address.endsWith('/interactions')) return new Response(JSON.stringify(geminiReply(ONE)));
        if (address.endsWith(FILE.name) && init.method === 'DELETE') return new Response('{}');
        if (address.endsWith(FILE.name)) return new Response(JSON.stringify({ state: 'ACTIVE' }));
        throw new Error(`unexpected request: ${address}`);
      }),
    );
    const row = await photoRow(await insertUser());
    await using introspector = await introspectWorkflow(env.IMPORT_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
    });
    await env.IMPORT_WORKFLOW.create({ id: `import-${row.id}-1`, params: { importId: row.id, attempt: 1 } });
    const [instance] = await introspector.get();
    await instance.waitForStatus('complete');

    const after = await reload(row);
    expect(after).toMatchObject({ status: 'done', used_best: 1, model: BEST });
    const recipe = await env.DB.prepare('SELECT platform, source_url FROM recipes WHERE id = ?').bind(after.recipe_id).first();
    expect(recipe).toEqual({ platform: 'photo', source_url: PHOTO_URL });
    const interactions = fetch.mock.calls.filter(([url]) => String(url).endsWith('/interactions'));
    expect(JSON.parse(interactions[0][1].body)).toMatchObject({ model: BEST });
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith(FILE.name) && init?.method === 'DELETE')).toBe(true);
  });
});

describe('import endpoints for a photo', () => {
  const START = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
  const UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=xyz';
  const PICTURE = 'jpeg bytes';

  let workflow;
  let testEnv;
  let uploaded;
  // Google's file store, faked by URL: the upload's two requests and a delete.
  const fakeGoogle = ({ upload = () => new Response(JSON.stringify({ file: { name: FILE.name, uri: FILE.uri } })) } = {}) => {
    uploaded = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init = {}) => {
        const address = String(url);
        if (address === START) return new Response('{}', { headers: { 'x-goog-upload-url': UPLOAD_URL } });
        if (address === UPLOAD_URL) {
          uploaded.push({ type: init.headers, body: await new Response(init.body).text() });
          return upload();
        }
        if (address.endsWith(FILE.name) && init.method === 'DELETE') return new Response('{}');
        throw new Error(`unexpected request: ${address}`);
      }),
    );
  };
  beforeEach(() => {
    workflow = { create: vi.fn(async () => ({ id: 'instance' })) };
    testEnv = { ...env, IMPORT_WORKFLOW: workflow };
    fakeGoogle();
  });

  const signUp = async (name = 'dana') => {
    const response = await register(name);
    return { cookie: cookiesFrom(response), userId: (await response.json()).user.id };
  };
  const sendPhoto = (cookie, { body = PICTURE, type = 'image/jpeg', length = new TextEncoder().encode(body).length, method = 'POST' } = {}) => {
    const headers = { 'Content-Type': type, 'Content-Length': String(length) };
    if (cookie) headers.Cookie = cookie;
    return worker.fetch(new Request('http://localhost/api/imports/photo', { method, headers, body: method === 'POST' ? body : undefined }), testEnv);
  };
  const errorOf = async (response) => (await response.json()).error;
  const rows = async () => (await env.DB.prepare('SELECT * FROM llm_requests ORDER BY id').all()).results;
  const startRequests = () => fetch.mock.calls.filter(([url]) => String(url) === START);

  it('uploads the picture, starts the Workflow with the best model chosen, and answers 202 with the card', async () => {
    const { cookie, userId } = await signUp();
    const response = await sendPhoto(cookie);
    expect(response.status).toBe(202);

    const [row] = await rows();
    expect(row).toMatchObject({ user_id: userId, platform: 'photo', status: 'running', stage: 'meta', title: null, quota_day: today(), used_best: 0 });
    expect(row.source_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.source_url).toBe(`photo:${row.source_id}`);
    expect(JSON.parse(row.state)).toEqual({ photo: FILE, bestChosen: true });
    expect(uploaded.map((u) => u.body)).toEqual([PICTURE]);
    expect(startRequests()[0][1].headers['X-Goog-Upload-Header-Content-Type']).toBe('image/jpeg');
    expect(workflow.create).toHaveBeenCalledWith({ id: `import-${row.id}-1`, params: { importId: row.id, attempt: 1 } });
    expect((await response.json()).import).toMatchObject({ id: row.id, status: 'running', link: '', fromPhoto: true, title: null });
  });

  it('takes the same picture twice as two imports', async () => {
    const { cookie } = await signUp();
    expect((await sendPhoto(cookie)).status).toBe(202);
    expect((await sendPhoto(cookie)).status).toBe(202);
    const [first, second] = await rows();
    expect(first.source_id).not.toBe(second.source_id);
  });

  it.each(['image/png', 'image/webp', 'image/heic', 'image/heif', 'IMAGE/JPEG; charset=binary'])('accepts %s', async (type) => {
    const { cookie } = await signUp();
    expect((await sendPhoto(cookie, { type })).status).toBe(202);
  });

  it.each(['application/json', 'text/plain', 'image/gif', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'refuses %s as photo_invalid without uploading',
    async (type) => {
      const { cookie } = await signUp();
      const response = await sendPhoto(cookie, { type });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('photo_invalid');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('refuses an empty picture as photo_invalid', async () => {
    const { cookie } = await signUp();
    const response = await sendPhoto(cookie, { body: '', length: 0 });
    expect(await errorOf(response)).toBe('photo_invalid');
    expect(await rows()).toEqual([]);
  });

  it('refuses a picture over 20 MB as photo_too_big, before reading it', async () => {
    const { cookie } = await signUp();
    const response = await sendPhoto(cookie, { length: 20 * 1024 * 1024 + 1 });
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toBe('photo_too_big');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    const response = await sendPhoto(null);
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('not_logged_in');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 405 for another method', async () => {
    const { cookie } = await signUp();
    expect((await sendPhoto(cookie, { method: 'GET' })).status).toBe(405);
  });

  it('keeps to the daily cap, uploading nothing past it', async () => {
    const { cookie } = await signUp();
    testEnv.IMPORT_DAILY_LIMIT = 1;
    expect((await sendPhoto(cookie)).status).toBe(202);
    const response = await sendPhoto(cookie);
    expect(response.status).toBe(429);
    expect(await errorOf(response)).toBe('too_many_imports');
    expect(startRequests()).toHaveLength(1);
  });

  it('starts while the best model is left even when every import model is out, and not when both are out', async () => {
    const { cookie } = await signUp();
    for (const model of IMPORT_MODELS) await markOut(model);
    expect((await sendPhoto(cookie)).status).toBe(202);
    await markOut(BEST);
    const response = await sendPhoto(cookie);
    expect(response.status).toBe(429);
    expect(await errorOf(response)).toBe('quota');
  });

  it('answers photo_upload_failed, with no card, when Google won’t take the upload', async () => {
    fakeGoogle({ upload: () => new Response('nope', { status: 500 }) });
    const { cookie } = await signUp();
    const response = await sendPhoto(cookie);
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe('photo_upload_failed');
    expect(await rows()).toEqual([]);
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it('lists a photo import with no link and fromPhoto', async () => {
    const { cookie, userId } = await signUp();
    await photoRow(userId);
    const { imports } = await (await call('/api/imports', { cookie, env: testEnv })).json();
    expect(imports[0]).toMatchObject({ link: '', fromPhoto: true });
  });

  it('a Retry keeps the uploaded photo and the best model, and the old row lets go of it', async () => {
    const { cookie, userId } = await signUp();
    const failed = await photoRow(userId, { status: 'failed', error: 'llm_error', stage: 'extract' });
    const response = await call(`/api/imports/${failed.id}/retry`, { method: 'POST', body: {}, cookie, env: testEnv });
    expect(response.status).toBe(202);
    const [old, added] = await rows();
    expect(JSON.parse(added.state)).toEqual({ photo: FILE, bestChosen: true });
    expect(added).toMatchObject({ platform: 'photo', source_url: PHOTO_URL, stage: 'meta' });
    expect(old.status).toBe('dismissed');
    expect(JSON.parse(old.state).photo).toBeUndefined();
  });

  it.each(['photo_unreadable', 'photo_expired'])('a %s import cannot be retried', async (error) => {
    const { cookie, userId } = await signUp();
    const failed = await photoRow(userId, { status: 'failed', error });
    const response = await call(`/api/imports/${failed.id}/retry`, { method: 'POST', body: {}, cookie, env: testEnv });
    expect(await errorOf(response)).toBe('not_retryable');
  });

  it('dismissing a photo import deletes the picture from Gemini’s store', async () => {
    const { cookie, userId } = await signUp();
    const failed = await photoRow(userId, { status: 'failed', error: 'quota' });
    expect((await call(`/api/imports/${failed.id}`, { method: 'DELETE', cookie, env: testEnv })).status).toBe(200);
    const deletes = fetch.mock.calls.filter(([url, init]) => String(url).endsWith(FILE.name) && init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(await reload(failed)).toMatchObject({ status: 'dismissed' });
    expect(JSON.parse((await reload(failed)).state).photo).toBeUndefined();
  });

  it('a photo recipe cannot be scanned again', async () => {
    const { cookie, userId } = await signUp();
    const recipe = await env.DB.prepare(`INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'photo', ?, ?, 'Asado') RETURNING id`)
      .bind(userId, PHOTO_URL, BEST)
      .first();
    const response = await call(`/api/recipes/${recipe.id}/rerun`, { method: 'POST', body: {}, cookie, env: testEnv });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('not_rerunnable');
  });
});

describe('a photo recipe in the API', () => {
  it('has no link and fromPhoto, in My recipes, Browse and a copy', async () => {
    const dana = await register('dana');
    const danaCookie = cookiesFrom(dana);
    const danaId = (await dana.json()).user.id;
    const noa = cookiesFrom(await register('noa'));
    const { id } = await env.DB.prepare(`INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'photo', ?, ?, 'Asado') RETURNING id`)
      .bind(danaId, PHOTO_URL, BEST)
      .first();

    const [mine] = (await (await call('/api/recipes', { cookie: danaCookie })).json()).recipes;
    expect(mine).toMatchObject({ id, link: '', fromPhoto: true });
    const { recipe } = await (await call(`/api/recipes/${id}`, { cookie: danaCookie })).json();
    expect(recipe).toMatchObject({ link: '', fromPhoto: true });

    const [browsed] = (await (await call('/api/browse?seed=7', { cookie: noa })).json()).recipes;
    expect(browsed).toMatchObject({ id, link: '', fromPhoto: true });
    const copied = await (await call(`/api/browse/${id}/copy`, { method: 'POST', body: {}, cookie: noa })).json();
    expect(copied.recipe).toMatchObject({ link: '', fromPhoto: true });
  });

  it('marks every other recipe fromPhoto false', async () => {
    const cookie = cookiesFrom(await register('dana'));
    const body = { en: { name: 'Tea', ingredients: [], steps: [] }, he: { name: '', ingredients: [], steps: [] } };
    const { recipe } = await (await call('/api/recipes', { method: 'POST', body, cookie })).json();
    expect(recipe).toMatchObject({ link: '', fromPhoto: false });
  });
});
