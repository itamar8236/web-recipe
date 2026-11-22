import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { errorMessage, formatTime, pickLanguage, stageMessage, strings } from './i18n';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

// The in-memory store is the guest mode; logged-in users go to the backend (see below).
beforeEach(() => api.setGuestMode(true));

const newRecipe = (name) => api.saveRecipe(null, { en: content(name), he: content('') });

describe('guest: starting data', () => {
  it('starts with no tags and no recipes', async () => {
    expect(await api.getTags()).toEqual([]);
    expect(await api.getRecipes()).toEqual([]);
  });

  it('forgets everything when someone else starts using the app', async () => {
    const recipe = await newRecipe('Mine');
    await api.setRecipeTags(recipe.id, ['Mine']);
    api.setGuestMode(true);
    expect(await api.getTags()).toEqual([]);
    expect(await api.getRecipes()).toEqual([]);
  });
});

describe('guest: recipes', () => {
  it('saves a new recipe with no tags and trims blank lines', async () => {
    const saved = await api.saveRecipe(null, {
      en: content(' Pancakes ', ['flour', '  ', ' milk '], ['mix', '']),
      he: content(''),
    });
    const loaded = await api.getRecipe(saved.id);
    expect(loaded.en).toEqual(content('Pancakes', ['flour', 'milk'], ['mix']));
    expect(loaded.tagIds).toEqual([]);
  });

  it('accepts a recipe written only in Hebrew', async () => {
    const saved = await api.saveRecipe(null, { en: content(''), he: content('פנקייק') });
    expect(saved.he.name).toBe('פנקייק');
  });

  it('rejects a recipe with no name in either language', async () => {
    await expect(api.saveRecipe(null, { en: content(''), he: content('  ') })).rejects.toMatchObject({
      code: 'name_required',
    });
  });

  it('keeps calories and protein, and checks them like the backend', async () => {
    const saved = await api.saveRecipe(null, { en: content('Toast'), he: content(''), calories: 300, protein: 9 });
    expect(saved).toMatchObject({ calories: 300, protein: 9 });
    expect((await newRecipe('Plain')).calories).toBeNull();
    await api.saveRecipe(saved.id, { en: content('Toast'), he: content(''), calories: null, protein: 9 });
    expect(await api.getRecipe(saved.id)).toMatchObject({ calories: null, protein: 9 });
    await expect(
      api.saveRecipe(null, { en: content('Toast'), he: content(''), calories: 1.5 }),
    ).rejects.toMatchObject({ code: 'invalid_nutrition' });
  });

  it('keeps the author tidied, keeps it when left out, and checks its length like the backend', async () => {
    const saved = await api.saveRecipe(null, { en: content('Toast'), he: content(''), author: '  Tom   Smith ' });
    expect(saved.author).toBe('Tom Smith');
    expect((await newRecipe('Plain')).author).toBe('');
    expect((await api.saveRecipe(saved.id, { en: content('Toast'), he: content('') })).author).toBe('Tom Smith');
    await expect(
      api.saveRecipe(null, { en: content('Toast'), he: content(''), author: 'x'.repeat(101) }),
    ).rejects.toMatchObject({ code: 'too_long' });
  });

  it('updates an existing recipe and keeps its tags', async () => {
    const recipe = await newRecipe('Shakshuka');
    const { tags } = await api.setRecipeTags(recipe.id, ['Dinner']);
    await api.saveRecipe(recipe.id, { en: content('Green Shakshuka'), he: content('') });
    const loaded = await api.getRecipe(recipe.id);
    expect(loaded.en.name).toBe('Green Shakshuka');
    expect(loaded.tagIds).toEqual([tags[0].id]);
  });

  it('manual recipes have no source link', async () => {
    const manual = await newRecipe('Toast');
    expect(manual.link).toBe('');
  });

  it('sets favorite, and edits keep it', async () => {
    const { id } = await newRecipe('Lemon Chicken');
    expect((await api.setFavorite(id, true)).favorite).toBe(true);
    await api.saveRecipe(id, { en: content('Lemon Chicken v2'), he: content('') });
    expect((await api.getRecipe(id)).favorite).toBe(true);
    await api.setFavorite(id, false);
    expect((await api.getRecipe(id)).favorite).toBe(false);
  });

  it('new recipes are not favorites', async () => {
    const saved = await api.saveRecipe(null, { en: content('Toast'), he: content('') });
    expect(saved.favorite).toBe(false);
  });

  it('deletes a recipe', async () => {
    const { id } = await newRecipe('Toast');
    await api.deleteRecipe(id);
    expect(await api.getRecipe(id)).toBeNull();
  });
});

describe('guest: tags', () => {
  it('gives a recipe several tags, creating the new ones', async () => {
    const recipe = await newRecipe('Soup');
    const { recipe: tagged, tags } = await api.setRecipeTags(recipe.id, [' Soups ', 'Quick']);
    expect(tags.map((tag) => tag.name)).toEqual(['Soups', 'Quick']);
    expect(tagged.tagIds).toEqual(tags.map((tag) => tag.id));
    expect(await api.getTags()).toEqual(tags);
  });

  it('reuses an existing tag whatever the case', async () => {
    const first = await newRecipe('Soup');
    const second = await newRecipe('Stew');
    const { tags } = await api.setRecipeTags(first.id, ['Dinner']);
    const { recipe, tags: after } = await api.setRecipeTags(second.id, ['dinner', 'DINNER']);
    expect(after).toEqual(tags);
    expect(recipe.tagIds).toEqual([tags[0].id]);
  });

  it('drops a tag when its last recipe drops it or is deleted', async () => {
    const first = await newRecipe('Soup');
    const second = await newRecipe('Stew');
    await api.setRecipeTags(first.id, ['Dinner', 'Quick']);
    await api.setRecipeTags(second.id, ['Dinner']);

    const { tags } = await api.setRecipeTags(first.id, []);
    expect(tags.map((tag) => tag.name)).toEqual(['Dinner']);
    await api.deleteRecipe(second.id);
    expect(await api.getTags()).toEqual([]);
  });

  it('renames a tag, but not to an empty name or the name of another one', async () => {
    const recipe = await newRecipe('Soup');
    const { tags } = await api.setRecipeTags(recipe.id, ['Soups', 'Quick']);
    await api.renameTag(tags[0].id, ' Hot soups ');
    expect((await api.getTags())[0].name).toBe('Hot soups');
    await expect(api.renameTag(tags[0].id, '   ')).rejects.toMatchObject({ code: 'name_required' });
    await expect(api.renameTag(tags[1].id, 'hot soups')).rejects.toMatchObject({ code: 'tag_exists' });
  });

  it('rejects an empty tag name', async () => {
    const recipe = await newRecipe('Soup');
    await expect(api.setRecipeTags(recipe.id, ['  '])).rejects.toMatchObject({ code: 'name_required' });
  });
});

describe('pickLanguage', () => {
  it('uses the current language when it has a name', () => {
    const recipe = { en: content('Tea'), he: content('תה') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'תה', translated: true });
  });

  it('falls back to the other language when empty', () => {
    const recipe = { en: content('Tea'), he: content('') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'Tea', translated: false });
  });
});

describe('login', () => {
  const mockFetch = (status, body) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));

  afterEach(() => vi.unstubAllGlobals());

  it('getMe returns the user, or null when not logged in', async () => {
    mockFetch(200, { user: { id: 1, username: 'dana', is_admin: false } });
    expect((await api.getMe()).username).toBe('dana');
    mockFetch(401, { error: 'not_logged_in' });
    expect(await api.getMe()).toBeNull();
  });

  it('login sends the credentials as JSON', async () => {
    mockFetch(200, { user: { id: 1, username: 'dana' } });
    await api.login('dana', 'password123');
    const [path, options] = fetch.mock.calls[0];
    expect(path).toBe('/api/auth/login');
    expect(JSON.parse(options.body)).toEqual({ username: 'dana', password: 'password123' });
  });

  it('turns backend errors into ApiError with the code', async () => {
    mockFetch(401, { error: 'invalid_credentials' });
    await expect(api.login('dana', 'nope')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('reports an unreachable backend as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fail'); }));
    await expect(api.register('dana', 'password123')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('logged in: data goes to the backend', () => {
  const mockFetch = (status, body) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
  const lastCall = () => {
    const [path, options] = fetch.mock.calls.at(-1);
    return { path, method: options.method, body: options.body && JSON.parse(options.body) };
  };

  beforeEach(() => api.setGuestMode(false));
  afterEach(() => {
    vi.unstubAllGlobals();
    api.setLoggedOutHandler(() => {});
  });

  it('loads tags and recipes', async () => {
    mockFetch(200, { tags: [{ id: 1, name: 'Soups' }] });
    expect(await api.getTags()).toEqual([{ id: 1, name: 'Soups' }]);
    expect(lastCall()).toMatchObject({ path: '/api/tags', method: 'GET' });

    mockFetch(200, { recipes: [] });
    expect(await api.getRecipes()).toEqual([]);
    expect(lastCall().path).toBe('/api/recipes');
  });

  it('creates a recipe with POST and edits it with PUT', async () => {
    const data = { en: content('Tea'), he: content('') };
    mockFetch(201, { recipe: { id: 7 } });
    expect((await api.saveRecipe(null, data)).id).toBe(7);
    expect(lastCall()).toEqual({ path: '/api/recipes', method: 'POST', body: data });

    mockFetch(200, { recipe: { id: 7 } });
    await api.saveRecipe(7, data);
    expect(lastCall()).toMatchObject({ path: '/api/recipes/7', method: 'PUT' });
  });

  it('saves tags and favorites', async () => {
    mockFetch(200, { tag: { id: 2, name: 'New' } });
    await api.renameTag(2, 'New');
    expect(lastCall()).toEqual({ path: '/api/tags/2', method: 'PUT', body: { name: 'New' } });

    mockFetch(200, { recipe: { id: 7, tagIds: [2] }, tags: [{ id: 2, name: 'New' }] });
    const answer = await api.setRecipeTags(7, ['New']);
    expect(answer.tags).toEqual([{ id: 2, name: 'New' }]);
    expect(lastCall()).toEqual({ path: '/api/recipes/7/tags', method: 'PUT', body: { tags: ['New'] } });

    mockFetch(200, { recipe: { id: 7, favorite: true } });
    await api.setFavorite(7, true);
    expect(lastCall()).toEqual({ path: '/api/recipes/7/favorite', method: 'PUT', body: { favorite: true } });
  });

  it('updates the account with PUT /api/auth/me', async () => {
    mockFetch(200, { user: { id: 1, username: 'noa' } });
    expect((await api.updateAccount({ username: 'noa' })).username).toBe('noa');
    expect(lastCall()).toEqual({ path: '/api/auth/me', method: 'PUT', body: { username: 'noa' } });
  });

  it('returns null for a missing recipe', async () => {
    mockFetch(404, { error: 'not_found' });
    expect(await api.getRecipe(99)).toBeNull();
  });

  it('passes on backend errors with their code', async () => {
    mockFetch(409, { error: 'tag_exists' });
    await expect(api.renameTag(2, 'Soups')).rejects.toMatchObject({ code: 'tag_exists' });
  });

  it('reports a lost session so the app can show the login screen', async () => {
    const loggedOut = vi.fn();
    api.setLoggedOutHandler(loggedOut);
    mockFetch(401, { error: 'not_logged_in' });
    await expect(api.getRecipes()).rejects.toMatchObject({ status: 401 });
    expect(loggedOut).toHaveBeenCalled();
  });
});

describe('errorMessage', () => {
  it('maps known codes and falls back to a generic message', () => {
    expect(errorMessage(strings.en, { code: 'username_taken' })).toBe(strings.en.errUsernameTaken);
    expect(errorMessage(strings.he, { code: 'weird' })).toBe(strings.he.errGeneric);
  });

  it.each([
    ['link_invalid', "That doesn't look like a link to a video or a recipe"],
    ['link_unsupported', "This link can't be imported"],
    ['already_imported', 'You already have this recipe'],
    ['too_many_imports', 'Wait for the current imports to finish'],
    ['video_unavailable', 'Page, video or post not found'],
    ['login_required', 'This page needs a login. Only public pages and posts can be imported.'],
    ['source_blocked', "Couldn't reach the site. Check the link, or try again later."],
    ['video_private', 'The video must be public'],
    ['video_too_long', 'Only short videos for now'],
    ['no_recipe', 'No recipe found, add it manually'],
    ['multiple_recipes', 'Pick a link with one recipe'],
    ['llm_error', 'Temporary problem'],
    ['bad_result', "Couldn't read a clean recipe"],
    ['timed_out', 'Something went wrong'],
  ])('%s has its own message', (code, message) => {
    expect(errorMessage(strings.en, { code })).toBe(message);
    expect(errorMessage(strings.he, { code })).not.toBe(strings.he.errGeneric);
  });

  it.each(['model_approval_needed', 'not_retryable', 'not_rerunnable', 'model_busy', 'nothing_to_translate', 'import_needs_login', 'photo_invalid', 'photo_too_big', 'photo_unreadable', 'photo_expired', 'photo_copyrighted', 'photo_upload_failed'])(
    '%s has its own message in both languages',
    (code) => {
      expect(errorMessage(strings.en, { code })).not.toBe(strings.en.errGeneric);
      expect(errorMessage(strings.he, { code })).not.toBe(strings.he.errGeneric);
    },
  );

  it('says when to try again after a quota failure', () => {
    const retryAt = Date.UTC(2026, 10, 9, 8, 0);
    const time = formatTime(strings.en, retryAt);
    expect(time).not.toBe('');
    expect(errorMessage(strings.en, { code: 'quota', retryAt })).toBe(`Daily limit reached, try after ${time}`);
    expect(errorMessage(strings.he, { code: 'quota', retryAt })).toContain(formatTime(strings.he, retryAt));
  });

  it('still gives a sensible quota message when the time is not known', () => {
    expect(errorMessage(strings.en, { code: 'quota' })).toBe('Daily limit reached, try again later');
  });
});

describe('stageMessage', () => {
  it.each([
    ['meta', 'Getting the details...'],
    ['video', 'Getting the video...'],
    ['extract', 'Reading the recipe...'],
    ['save', 'Reading the recipe...'],
    ['a stage added later', 'Reading the recipe...'],
  ])('says what is happening during %s', (stage, message) => {
    expect(stageMessage(strings.en, stage)).toBe(message);
    expect(stageMessage(strings.he, stage)).toBeTruthy();
    expect(stageMessage(strings.he, stage)).not.toBe(message);
  });

  it('says the photo is being read at every stage of a photo import', () => {
    for (const stage of ['meta', 'video', 'extract']) expect(stageMessage(strings.en, stage, true)).toBe('Reading the photo...');
    expect(stageMessage(strings.he, 'meta', true)).toBe(strings.he.importStagePhoto);
  });
});

describe('strings', () => {
  it('has the same keys in English and Hebrew', () => {
    expect(Object.keys(strings.he).sort()).toEqual(Object.keys(strings.en).sort());
  });

  it('has the same kind of value for every key, and none empty', () => {
    for (const key of Object.keys(strings.en)) {
      expect(typeof strings.he[key], key).toBe(typeof strings.en[key]);
      if (typeof strings.en[key] === 'string') expect(strings.he[key], key).not.toBe('');
    }
  });

  it('puts the name or time into the messages that need one', () => {
    for (const lang of ['en', 'he']) {
      expect(strings[lang].recipeReady('X')).toContain('X');
      expect(strings[lang].errQuota('10:00')).toContain('10:00');
    }
  });
});

describe('formatTime', () => {
  it('is empty when the time is not known', () => {
    expect(formatTime(strings.en, null)).toBe('');
    expect(formatTime(strings.en, undefined)).toBe('');
  });

  it('shows a clock time with minutes', () => {
    expect(formatTime(strings.he, Date.UTC(2026, 10, 9, 8, 5))).toMatch(/\d{1,2}:05/);
  });
});

describe('guest: imports need an account', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['getImports', () => api.getImports()],
    ['startImport', () => api.startImport('https://youtu.be/dQw4w9WgXcQ')],
    ['retryImport', () => api.retryImport(1)],
    ['dismissImport', () => api.dismissImport(1)],
    ['rerunRecipe', () => api.rerunRecipe(1)],
    ['translateRecipe', () => api.translateRecipe('en', { name: 'Tea', ingredients: [], steps: [] })],
    ['estimateNutrition', () => api.estimateNutrition({ name: 'Tea', ingredients: [], steps: [] })],
    ['suggestSubstitutes', () => api.suggestSubstitutes(1, 'en', 0, 'en')],
    ['startPhotoImport', () => api.startPhotoImport(new Blob(['x'], { type: 'image/jpeg' }))],
  ])('%s is refused and never calls the backend', async (_, action) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(action()).rejects.toMatchObject({ code: 'import_needs_login' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('logged in: imports', () => {
  const mockFetch = (status, body) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
  const lastCall = () => {
    const [path, options] = fetch.mock.calls.at(-1);
    return { path, method: options.method, body: options.body && JSON.parse(options.body) };
  };
  const card = { id: 5, status: 'running' };

  beforeEach(() => api.setGuestMode(false));
  afterEach(() => {
    vi.unstubAllGlobals();
    api.setLoggedOutHandler(() => {});
  });

  it('loads the imports and the model state', async () => {
    const data = { imports: [card], models: { bestAvailable: true } };
    mockFetch(200, data);
    expect(await api.getImports()).toEqual(data);
    expect(lastCall()).toMatchObject({ path: '/api/imports', method: 'GET' });
  });

  it('sends only the link when starting an import', async () => {
    mockFetch(202, { import: card });
    expect(await api.startImport('https://youtu.be/x')).toEqual(card);
    expect(lastCall()).toEqual({ path: '/api/imports', method: 'POST', body: { url: 'https://youtu.be/x' } });
  });

  it('sends a photo as it is, with its own type, and returns the card', async () => {
    mockFetch(202, { import: card });
    const photo = new Blob(['jpeg bytes'], { type: 'image/jpeg' });
    expect(await api.startPhotoImport(photo)).toEqual(card);
    const [path, options] = fetch.mock.calls.at(-1);
    expect(path).toBe('/api/imports/photo');
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'image/jpeg' } });
    expect(options.body).toBe(photo);
  });

  it('retries and returns the new card', async () => {
    mockFetch(202, { import: card });
    expect(await api.retryImport(4)).toEqual(card);
    expect(lastCall()).toEqual({ path: '/api/imports/4/retry', method: 'POST', body: {} });
  });

  it('dismisses with DELETE', async () => {
    mockFetch(200, { ok: true });
    await api.dismissImport(5);
    expect(lastCall()).toMatchObject({ path: '/api/imports/5', method: 'DELETE' });
  });

  it('scans a recipe again, asking for the best model only when the user wants it', async () => {
    mockFetch(202, { import: card });
    expect(await api.rerunRecipe(7)).toEqual(card);
    expect(lastCall()).toEqual({ path: '/api/recipes/7/rerun', method: 'POST', body: {} });
    await api.rerunRecipe(7, true);
    expect(lastCall().body).toEqual({ model: 'best' });
  });

  it('translates one language and returns only the text', async () => {
    const content = { name: 'Tea', ingredients: ['Water'], steps: ['Boil'] };
    const hebrew = { name: 'תה', ingredients: ['מים'], steps: ['מרתיחים'] };
    mockFetch(200, { content: hebrew });
    expect(await api.translateRecipe('en', content)).toEqual(hebrew);
    expect(lastCall()).toEqual({ path: '/api/translate', method: 'POST', body: { from: 'en', content } });
    await api.translateRecipe('en', content, 12);
    expect(lastCall().body).toEqual({ from: 'en', content, recipeId: 12 });
  });

  it('estimates calories and protein, saving nothing', async () => {
    const content = { name: 'Tea', ingredients: ['Water'], steps: ['Boil'] };
    mockFetch(200, { calories: 2, protein: 0 });
    expect(await api.estimateNutrition(content)).toEqual({ calories: 2, protein: 0 });
    expect(lastCall()).toEqual({ path: '/api/nutrition', method: 'POST', body: { content } });
    await api.estimateNutrition(content, 12);
    expect(lastCall().body).toEqual({ content, recipeId: 12 });
  });

  it('asks for substitutes, saving nothing', async () => {
    const substitutes = [{ name: 'Oil', amount: '1 tbsp', note: 'Less rich.' }];
    mockFetch(200, { substitutes });
    expect(await api.suggestSubstitutes(12, 'he', 1, 'en')).toEqual(substitutes);
    expect(lastCall()).toEqual({ path: '/api/substitute', method: 'POST', body: { recipeId: 12, from: 'he', index: 1, lang: 'en' } });
  });

  it('passes on the backend error codes', async () => {
    mockFetch(400, { error: 'link_unsupported' });
    await expect(api.startImport('https://example.com')).rejects.toMatchObject({ code: 'link_unsupported' });
    mockFetch(429, { error: 'quota' });
    await expect(api.startImport('https://youtu.be/x')).rejects.toMatchObject({ code: 'quota' });
  });

  it('reports a lost session while polling, so the login screen comes back', async () => {
    const loggedOut = vi.fn();
    api.setLoggedOutHandler(loggedOut);
    mockFetch(401, { error: 'not_logged_in' });
    await expect(api.getImports()).rejects.toMatchObject({ status: 401 });
    expect(loggedOut).toHaveBeenCalled();
  });
});

describe('browse and public recipes', () => {
  const mockFetch = (status, body) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
  const lastCall = () => {
    const [path, options] = fetch.mock.calls.at(-1);
    return { path, method: options.method, body: options.body && JSON.parse(options.body) };
  };

  afterEach(() => vi.unstubAllGlobals());

  it('a guest cannot browse or copy, and nothing is sent', async () => {
    mockFetch(200, {});
    await expect(api.getBrowse(5)).rejects.toMatchObject({ code: 'browse_needs_login' });
    await expect(api.copyRecipe(1)).rejects.toMatchObject({ code: 'browse_needs_login' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a guest recipe keeps the public flag it is given', async () => {
    const recipe = await newRecipe('Toast');
    expect(recipe.public).toBe(true);
    expect((await api.setRecipePublic(recipe.id, false)).public).toBe(false);
    await expect(api.setRecipePublic(999, false)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('loads a page of the feed, then the next one from its mark', async () => {
    api.setGuestMode(false);
    const page = { recipes: [{ id: 3, owner: 'dana', tags: [] }], next: '17.3' };
    mockFetch(200, page);
    expect(await api.getBrowse(42)).toEqual(page);
    expect(lastCall()).toMatchObject({ path: '/api/browse?seed=42', method: 'GET' });
    await api.getBrowse(42, page.next);
    expect(lastCall().path).toBe('/api/browse?seed=42&after=17.3');
  });

  it('picks a seed the backend accepts', () => {
    for (let i = 0; i < 50; i++) {
      const seed = api.newBrowseSeed();
      expect(Number.isInteger(seed) && seed >= 1 && seed <= 1000002).toBe(true);
    }
  });

  it('saves a copy and sets a recipe private', async () => {
    api.setGuestMode(false);
    mockFetch(201, { recipe: { id: 9 } });
    expect((await api.copyRecipe(3)).id).toBe(9);
    expect(lastCall()).toEqual({ path: '/api/browse/3/copy', method: 'POST', body: {} });

    mockFetch(200, { recipe: { id: 9, public: false } });
    expect((await api.setRecipePublic(9, false)).public).toBe(false);
    expect(lastCall()).toEqual({ path: '/api/recipes/9/public', method: 'PUT', body: { public: false } });
  });

  it('sends the account defaults that changed', async () => {
    api.setGuestMode(false);
    mockFetch(200, { user: { id: 1, username: 'dana', defaultPublic: false, copyTags: true } });
    expect((await api.updateAccount({ defaultPublic: false })).defaultPublic).toBe(false);
    expect(lastCall()).toEqual({ path: '/api/auth/me', method: 'PUT', body: { defaultPublic: false } });
  });
});
