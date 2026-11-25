import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thumbnailUrls } from '../src/import/sources/youtube.js';
import { savePictureForImport, STAGES, runStage } from '../src/import/stages.js';
import { pictureForLink, previewImageUrl, resize } from '../src/pictures.js';
import worker from '../src/index.js';
import { call, cookiesFrom, insertImport, register } from './helpers.js';
import { JPEG, jpegResponse, WEBP } from './picture-bytes.js';

afterEach(() => vi.unstubAllGlobals());

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

const as = (who) => ({
  get: (path) => call(path, { cookie: who }),
  post: (path, body) => call(path, { method: 'POST', body, cookie: who }),
  put: (path, body) => call(path, { method: 'PUT', body, cookie: who }),
  del: (path) => call(path, { method: 'DELETE', cookie: who }),
});

const newRecipe = async (who, name = 'Toast') =>
  (await (await as(who).post('/api/recipes', { en: content(name, ['bread'], ['toast it']), he: content('') })).json()).recipe;

// A multipart upload, as the browser sends it.
const sendPicture = (path, cookie, { full = JPEG, thumb = JPEG, type = 'image/jpeg', method = 'PUT' } = {}) => {
  const form = new FormData();
  if (full) form.append('full', new Blob([full], { type }), 'full');
  if (thumb) form.append('thumb', new Blob([thumb], { type }), 'thumb');
  return worker.fetch(new Request(`http://localhost${path}`, { method, headers: cookie ? { Cookie: cookie } : {}, body: form }), env);
};

const pictureRow = (recipeId) =>
  env.DB.prepare('SELECT edited, type, length(full) AS full, length(thumb) AS thumb FROM recipe_pictures WHERE recipe_id = ?').bind(recipeId).first();

let dana;
let noa;
beforeEach(async () => {
  dana = cookiesFrom(await register('dana'));
  noa = cookiesFrom(await register('noa'));
});

describe('previewImageUrl', () => {
  it('reads og:image, with its attributes in any order and its entities decoded', () => {
    expect(previewImageUrl('<meta property="og:image" content="https://cdn.site.com/a.jpg?x=1&amp;y=2">', 'https://site.com/r')).toBe('https://cdn.site.com/a.jpg?x=1&y=2');
    expect(previewImageUrl(`<meta content='https://cdn.site.com/b.jpg' property='og:image' />`, 'https://site.com/r')).toBe('https://cdn.site.com/b.jpg');
  });

  it('makes a relative address absolute, and falls back to twitter:image', () => {
    expect(previewImageUrl('<meta property="og:image" content="/img/c.jpg">', 'https://site.com/recipes/1')).toBe('https://site.com/img/c.jpg');
    expect(previewImageUrl('<meta name="twitter:image" content="https://site.com/d.jpg">', 'https://site.com/')).toBe('https://site.com/d.jpg');
  });

  it('gives null for a page with no preview image, or one that is not http(s)', () => {
    expect(previewImageUrl('<img src="logo.png"><meta property="og:title" content="x">', 'https://site.com/')).toBeNull();
    expect(previewImageUrl('<meta property="og:image" content="javascript:alert(1)">', 'https://site.com/')).toBeNull();
  });
});

describe('resize (the Images binding)', () => {
  it('makes a JPEG and a smaller thumb, never enlarging the picture', async () => {
    const { full, thumb, type } = await resize(env, JPEG);
    expect(type).toBe('image/jpeg');
    const size = async (bytes) => env.IMAGES.info(new Response(bytes).body);
    expect(await size(full)).toMatchObject({ width: 400, height: 300 });
    expect(await size(thumb)).toMatchObject({ width: 320, height: 240 });
  });
});

describe('pictureForLink', () => {
  it('tries the next address when one is missing, as a YouTube video without its biggest thumbnail', async () => {
    const [maxres, sd] = thumbnailUrls('dQw4w9WgXcQ');
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url) === sd ? jpegResponse() : new Response('', { status: 404 }))));
    expect(await pictureForLink(env, [maxres, sd])).toMatchObject({ type: 'image/jpeg' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([maxres, sd]);
  });

  it('follows no redirect by itself, and refuses one to a private address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.jpg' } })));
    expect(await pictureForLink(env, ['https://site.com/a.jpg'])).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
  });

  it('gives null, never throwing, for something that is not a picture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })));
    expect(await pictureForLink(env, ['https://site.com/a.jpg'])).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not really', { headers: { 'Content-Type': 'image/jpeg' } })));
    expect(await pictureForLink(env, ['https://site.com/a.jpg'])).toBeNull();
    expect(await pictureForLink(env, [])).toBeNull();
  });
});

describe('a recipe’s picture endpoints', () => {
  it('saves, shows and removes a picture the user chose', async () => {
    const recipe = await newRecipe(dana);
    expect(recipe.picture).toBeNull();

    const saved = await sendPicture(`/api/recipes/${recipe.id}/picture`, dana);
    expect(saved.status).toBe(200);
    const { picture } = await saved.json();
    expect(picture.url).toMatch(new RegExp(`^/api/recipes/${recipe.id}/picture\\?v=\\d+$`));
    expect(picture.thumb).toBe(`${picture.url}&size=thumb`);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 1, type: 'image/jpeg', full: JPEG.length });

    const [{ recipe: one }, { recipes }] = await Promise.all([
      (await as(dana).get(`/api/recipes/${recipe.id}`)).json(),
      (await as(dana).get('/api/recipes')).json(),
    ]);
    expect(one.picture).toEqual(picture);
    expect(recipes[0].picture).toEqual(picture);

    const shown = await as(dana).get(picture.url);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('Content-Type')).toBe('image/jpeg');
    expect(shown.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(JPEG);
    expect((await as(dana).get(picture.thumb)).status).toBe(200);

    expect((await as(dana).del(`/api/recipes/${recipe.id}/picture`)).status).toBe(200);
    expect(await pictureRow(recipe.id)).toBeNull();
    expect((await (await as(dana).get(`/api/recipes/${recipe.id}`)).json()).recipe.picture).toBeNull();
    expect((await as(dana).get(picture.url)).status).toBe(404);
  });

  it('takes WebP too, and a new picture replaces the old one', async () => {
    const recipe = await newRecipe(dana);
    await sendPicture(`/api/recipes/${recipe.id}/picture`, dana);
    expect((await sendPicture(`/api/recipes/${recipe.id}/picture`, dana, { full: WEBP, thumb: WEBP, type: 'image/webp' })).status).toBe(200);
    expect(await pictureRow(recipe.id)).toMatchObject({ type: 'image/webp', full: WEBP.length });
  });

  it.each([
    ['a PNG', { type: 'image/png' }],
    ['bytes that are not the type they claim', { full: new TextEncoder().encode('<html>hi</html>') }],
    ['a missing thumb', { thumb: null }],
    ['a JPEG and a WebP mixed', { thumb: WEBP, type: 'image/jpeg' }],
  ])('refuses %s as picture_invalid', async (_, options) => {
    const recipe = await newRecipe(dana);
    const response = await sendPicture(`/api/recipes/${recipe.id}/picture`, dana, options);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('picture_invalid');
  });

  it('refuses a JSON body as picture_invalid, and a picture over the limit as picture_too_big', async () => {
    const recipe = await newRecipe(dana);
    expect((await as(dana).put(`/api/recipes/${recipe.id}/picture`, {})).status).toBe(400);
    const big = new Uint8Array(1000001);
    big.set(JPEG.slice(0, 3));
    const response = await sendPicture(`/api/recipes/${recipe.id}/picture`, dana, { full: big });
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('picture_too_big');
  });

  it('needs a session', async () => {
    const recipe = await newRecipe(dana);
    expect((await sendPicture(`/api/recipes/${recipe.id}/picture`, null)).status).toBe(401);
    expect((await call(`/api/recipes/${recipe.id}/picture`)).status).toBe(401);
  });

  it('never lets another user change a picture, or see a private one', async () => {
    const recipe = await newRecipe(dana);
    await sendPicture(`/api/recipes/${recipe.id}/picture`, dana);
    expect((await sendPicture(`/api/recipes/${recipe.id}/picture`, noa)).status).toBe(404);
    expect((await as(noa).del(`/api/recipes/${recipe.id}/picture`)).status).toBe(404);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 1 });

    // Public, as Browse shows it: others can see it.
    expect((await as(noa).get(`/api/recipes/${recipe.id}/picture`)).status).toBe(200);
    await as(dana).put(`/api/recipes/${recipe.id}/public`, { public: false });
    expect((await as(noa).get(`/api/recipes/${recipe.id}/picture`)).status).toBe(404);
  });

  it('is shown in Browse, copied with the recipe, and deleted with it', async () => {
    const recipe = await newRecipe(dana);
    await sendPicture(`/api/recipes/${recipe.id}/picture`, dana);

    const [shown] = (await (await as(noa).get('/api/browse?seed=7')).json()).recipes;
    expect(shown.picture.url).toMatch(`/api/recipes/${recipe.id}/picture?v=`);

    const { recipe: copy } = await (await as(noa).post(`/api/browse/${recipe.id}/copy`, {})).json();
    expect(copy.picture.url).toMatch(`/api/recipes/${copy.id}/picture?v=`);
    expect(await pictureRow(copy.id)).toMatchObject({ edited: 1, full: JPEG.length });

    expect((await as(dana).del(`/api/recipes/${recipe.id}`)).status).toBe(200);
    expect(await pictureRow(recipe.id)).toBeNull();
    // The copy is noa's own, and keeps its picture.
    expect(await pictureRow(copy.id)).not.toBeNull();
  });

  it('answers 405 for another method', async () => {
    const recipe = await newRecipe(dana);
    expect((await as(dana).post(`/api/recipes/${recipe.id}/picture`, {})).status).toBe(405);
  });
});

describe('a photo import’s picture', () => {
  const userIdOf = async (cookie) => (await (await call('/api/auth/me', { cookie })).json()).user.id;
  const photoImport = async (cookie, fields = {}) =>
    insertImport(await userIdOf(cookie), { platform: 'photo', source_id: 'abc', source_url: 'photo:abc', ...fields });
  const waiting = (id) => env.DB.prepare('SELECT length(full) AS full FROM import_pictures WHERE request_id = ?').bind(id).first();
  const ONE = {
    language: 'en',
    en: { name: 'Toast', ingredients: ['bread'], steps: ['toast it'] },
    he: { name: 'טוסט', ingredients: ['לחם'], steps: ['לקלות'] },
  };

  it('waits while the import runs, then the save makes it the recipe’s', async () => {
    const row = await photoImport(dana, { stage: 'save', state: JSON.stringify({ recipe: ONE, model: 'm', done: ['meta', 'video', 'extract'], version: 2 }) });
    expect((await sendPicture(`/api/imports/${row.id}/picture`, dana)).status).toBe(200);
    expect(await waiting(row.id)).toEqual({ full: JPEG.length });

    await runStage(env, row.id, row.attempt, STAGES.find(({ name }) => name === 'save'), { files: { remove: async () => {} } });
    const after = await env.DB.prepare('SELECT status, recipe_id FROM llm_requests WHERE id = ?').bind(row.id).first();
    expect(after.status).toBe('done');
    expect(await pictureRow(after.recipe_id)).toMatchObject({ edited: 0, full: JPEG.length });
    expect(await waiting(row.id)).toBeNull();
  });

  it('goes to the recipe at once when the import already finished', async () => {
    const recipe = await newRecipe(dana);
    const row = await photoImport(dana, { status: 'done', recipe_id: recipe.id });
    expect((await sendPicture(`/api/imports/${row.id}/picture`, dana)).status).toBe(200);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 0 });
    expect(await waiting(row.id)).toBeNull();
  });

  it('moves to a Retry’s new row, and is deleted when the import is dismissed', async () => {
    const testEnv = { ...env, IMPORT_WORKFLOW: { create: async () => ({}) } };
    const row = await photoImport(dana, { status: 'failed', error: 'llm_error', quota_day: '2099-01-01', state: JSON.stringify({ photos: [{ name: 'files/x', uri: 'u', mimeType: 'image/jpeg' }] }) });
    await sendPicture(`/api/imports/${row.id}/picture`, dana);
    const retried = await call(`/api/imports/${row.id}/retry`, { method: 'POST', body: {}, cookie: dana, env: testEnv });
    expect(retried.status).toBe(202);
    const { import: card } = await retried.json();
    expect(await waiting(row.id)).toBeNull();
    expect(await waiting(card.id)).toEqual({ full: JPEG.length });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    expect((await call(`/api/imports/${card.id}`, { method: 'DELETE', cookie: dana })).status).toBe(200);
    expect(await waiting(card.id)).toBeNull();
  });

  describe('of several photos', () => {
    // Each photo's copy a different length, to tell them apart.
    const copyOf = (position) => new Uint8Array([...JPEG, ...new Uint8Array(position + 1)]);
    const sendCopy = (id, position) => sendPicture(`/api/imports/${id}/picture?position=${position}`, dana, { full: copyOf(position) });
    const waitingCount = async (id) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM import_pictures WHERE request_id = ?').bind(id).first()).n;

    it('keeps every copy while the import runs, then the save keeps only the one the model chose', async () => {
      const row = await photoImport(dana, { stage: 'save', state: JSON.stringify({ recipe: { ...ONE, cover: 2 }, model: 'm', done: ['meta', 'video', 'extract'], version: 2 }) });
      for (const position of [0, 1, 2]) expect((await sendCopy(row.id, position)).status).toBe(200);
      expect(await waitingCount(row.id)).toBe(3);

      await runStage(env, row.id, row.attempt, STAGES.find(({ name }) => name === 'save'), { files: { remove: async () => {} } });
      const after = await env.DB.prepare('SELECT recipe_id, state FROM llm_requests WHERE id = ?').bind(row.id).first();
      expect(await pictureRow(after.recipe_id)).toMatchObject({ full: copyOf(2).length });
      expect(await waitingCount(row.id)).toBe(0);
      expect(JSON.parse(after.state)).toEqual({ cover: 2 });
    });

    it('takes only the chosen copy when it arrives after the save', async () => {
      const recipe = await newRecipe(dana);
      const row = await photoImport(dana, { status: 'done', recipe_id: recipe.id, state: JSON.stringify({ cover: 1 }) });
      expect((await sendCopy(row.id, 0)).status).toBe(200);
      expect(await pictureRow(recipe.id)).toBeNull();
      expect((await sendCopy(row.id, 1)).status).toBe(200);
      expect(await pictureRow(recipe.id)).toMatchObject({ full: copyOf(1).length });
      expect(await waitingCount(row.id)).toBe(0);
    });

    it.each(['7', '-1', 'x', '1.5', '10'])('refuses position %s as picture_invalid', async (position) => {
      const row = await photoImport(dana);
      const response = await sendPicture(`/api/imports/${row.id}/picture?position=${position}`, dana);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('picture_invalid');
    });
  });

  it('is refused for another user’s import, or an import from a link', async () => {
    const row = await photoImport(dana);
    expect((await sendPicture(`/api/imports/${row.id}/picture`, noa)).status).toBe(404);
    const link = await insertImport(await userIdOf(dana), { source_id: 'other12345a', source_url: 'https://www.youtube.com/watch?v=other12345a' });
    expect((await sendPicture(`/api/imports/${link.id}/picture`, dana)).status).toBe(404);
    expect((await sendPicture(`/api/imports/${row.id}/picture`, null)).status).toBe(401);
  });
});

describe('the import’s picture step', () => {
  const userIdOf = async (cookie) => (await (await call('/api/auth/me', { cookie })).json()).user.id;
  const PICTURE = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg';
  const finished = async (recipeId) =>
    insertImport(await userIdOf(dana), { status: 'done', recipe_id: recipeId, state: JSON.stringify({ pictureUrls: [PICTURE] }) });

  it('saves the link’s picture, then forgets its address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    const recipe = await newRecipe(dana);
    const row = await finished(recipe.id);
    await savePictureForImport(env, row.id, row.attempt);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 0, type: 'image/jpeg' });
    expect((await env.DB.prepare('SELECT state FROM llm_requests WHERE id = ?').bind(row.id).first()).state).toBe('{}');
  });

  it('still saves the picture when the ready card was dismissed (opened) first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    const recipe = await newRecipe(dana);
    const row = await finished(recipe.id);
    expect((await call(`/api/imports/${row.id}`, { method: 'DELETE', cookie: dana })).status).toBe(200);
    await savePictureForImport(env, row.id, row.attempt);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 0, type: 'image/jpeg' });
  });

  it('keeps a picture the user chose on a re-scan, fetching nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    const recipe = await newRecipe(dana);
    await sendPicture(`/api/recipes/${recipe.id}/picture`, dana, { full: WEBP, thumb: WEBP, type: 'image/webp' });
    const row = await finished(recipe.id);
    await savePictureForImport(env, row.id, row.attempt);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 1, type: 'image/webp' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces an older picture from the link', async () => {
    const recipe = await newRecipe(dana);
    await env.DB.prepare(`INSERT INTO recipe_pictures VALUES (?, ?, ?, 'image/webp', 0, 1)`).bind(recipe.id, WEBP, WEBP).run();
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    const row = await finished(recipe.id);
    await savePictureForImport(env, row.id, row.attempt);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 0, type: 'image/jpeg' });
  });

  it('leaves the recipe without a picture, and the import done, when the picture can’t be had', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const recipe = await newRecipe(dana);
    const row = await finished(recipe.id);
    await expect(savePictureForImport(env, row.id, row.attempt)).resolves.toBeUndefined();
    expect(await pictureRow(recipe.id)).toBeNull();
    expect((await env.DB.prepare('SELECT status FROM llm_requests WHERE id = ?').bind(row.id).first()).status).toBe('done');
  });

  it('throws when the Images service is busy, keeping the address for the step’s retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    const busy = new Error('IMAGES_TRANSFORM_ERROR 9529: The image is too large to process or the service is too busy');
    const busyEnv = { ...env, IMAGES: { info: async () => { throw busy; } } };
    const recipe = await newRecipe(dana);
    const row = await finished(recipe.id);
    await expect(savePictureForImport(busyEnv, row.id, row.attempt)).rejects.toThrow('9529');
    expect(await pictureRow(recipe.id)).toBeNull();
    await savePictureForImport(env, row.id, row.attempt);
    expect(await pictureRow(recipe.id)).toMatchObject({ edited: 0, type: 'image/jpeg' });
  });
});
