// Imports from any other web page: which links are taken, how the page is fetched and read,
// the failures a user sees, and one whole Workflow run with a faked site and Gemini.

import { env, introspectWorkflow } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quotaDay } from '../src/import/models.js';
import { readLink } from '../src/import/sources/index.js';
import { pageText, structuredRecipe, web } from '../src/import/sources/web.js';
import { call, cookiesFrom, insertImport, insertUser, register } from './helpers.js';

const PAGE_URL = 'https://recipes.example.co.il/salad/';
const RECIPE_TEXT = 'Edamame salad. 1 bag edamame, 1 pomegranate, 2 celery stalks, juice of a lemon. Mix everything and season to taste.';
const recipePage = (body = `<p>${RECIPE_TEXT}</p>`) =>
  `<html><head><title>Edamame salad - Keren</title><script>var x = "menu";</script></head>
   <body><nav><a href="/">Home</a><a href="/cakes">Cakes</a></nav><article><h1>Edamame salad</h1>${body}</article>
   <footer>All rights reserved</footer></body></html>`;

let log;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const page = (body, headers = { 'content-type': 'text/html; charset=utf-8' }, status = 200) => new Response(body, { status, headers });
const redirect = (location) => new Response(null, { status: 301, headers: { location } });
const stubSite = (routes) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const answer = routes[String(url)];
      if (!answer) throw new Error(`unexpected request: ${url}`);
      return typeof answer === 'function' ? answer() : answer;
    }),
  );
const requested = () => fetch.mock.calls.map(([url]) => String(url));
const failure = (promise) => promise.catch((error) => error);

describe('web page links', () => {
  it('takes any public page, dropping the fragment and tracking parameters', () => {
    const link = readLink('https://www.mako.co.il/food/Recipe-436b.htm?utm_source=fb&fbclid=abc&page=2#comments');
    expect(link.source).toBe(web);
    expect(link.sourceUrl).toBe('https://www.mako.co.il/food/Recipe-436b.htm?page=2');
    expect(link.sourceId).toBe(link.sourceUrl);
  });

  it('keeps a Hebrew path as the same encoded link', () => {
    const link = readLink('https://kerenagam.co.il/סלט-אדממה/');
    expect(link.sourceUrl).toBe('https://kerenagam.co.il/%D7%A1%D7%9C%D7%98-%D7%90%D7%93%D7%9E%D7%9E%D7%94/');
  });

  it.each([
    ['an IP address', 'http://127.0.0.1/admin'],
    ['a numeric host the parser turns into an IP', 'http://2130706433/'],
    ['an IPv6 address', 'http://[::1]/'],
    ['localhost', 'http://localhost:8787/api/recipes'],
    ['a single-label name', 'http://intranet/'],
    ['a private-network name', 'https://router.local/'],
    ['another port', 'https://example.co.il:8443/recipe'],
    ['a login in the link', 'https://user:pass@example.co.il/recipe'],
  ])('refuses %s as link_unsupported', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_unsupported' });
  });

  it('still sends a YouTube link that is not a video to link_invalid, not to the web page reader', () => {
    expect(readLink('https://www.youtube.com/@somecook')).toEqual({ error: 'link_invalid' });
  });
});

describe('reading a web page', () => {
  it('sends the page text without scripts, menus and footers, with its title', async () => {
    stubSite({ [PAGE_URL]: page(recipePage()) });
    const post = await web.fetchPost(PAGE_URL);
    expect(post).toMatchObject({ sourceId: PAGE_URL, sourceUrl: PAGE_URL, title: 'Edamame salad - Keren', transcript: '', video: null });
    expect(post.text).toContain(RECIPE_TEXT);
    expect(post.text).not.toMatch(/menu|Cakes|rights reserved/);
  });

  it('puts a schema.org recipe first, and still sends the page for what it leaves out', () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Cakes' },
        {
          '@type': 'Recipe',
          name: 'Pecan cake',
          recipeYield: '12',
          recipeIngredient: ['140 g butter', '200 g sugar &amp; more'],
          recipeInstructions: [{ '@type': 'HowToSection', name: 'Cake', itemListElement: [{ '@type': 'HowToStep', text: 'Cream the <b>butter</b>' }] }, 'Bake 40 minutes'],
        },
      ],
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><p>Topping: 150 g pecans</p></body></html>`;
    expect(structuredRecipe(html)).toBe('Pecan cake\nMakes: 12\nIngredients:\n140 g butter\n200 g sugar & more\nInstructions:\nCake\nCream the butter\nBake 40 minutes');
    expect(pageText(html)).toBe('Topping: 150 g pecans');
  });

  it('ignores a schema.org recipe with no steps', () => {
    const ld = { '@type': 'Recipe', name: 'Cake', recipeIngredient: ['flour'] };
    expect(structuredRecipe(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)).toBeNull();
  });

  it('follows a redirect to another public host, checking each hop', async () => {
    const moved = 'https://www.example.co.il/salad/';
    stubSite({ [PAGE_URL]: redirect(moved), [moved]: page(recipePage()) });
    expect((await web.fetchPost(PAGE_URL)).text).toContain(RECIPE_TEXT);
    expect(requested()).toEqual([PAGE_URL, moved]);
  });

  it('never follows a redirect into a private network', async () => {
    stubSite({ [PAGE_URL]: redirect('http://169.254.169.254/latest/meta-data/') });
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code: 'link_unsupported', retryable: false });
    expect(requested()).toEqual([PAGE_URL]);
  });

  it('says a redirect to a login page needs a login', async () => {
    stubSite({ [PAGE_URL]: redirect('https://recipes.example.co.il/login/?next=/salad/') });
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code: 'login_required' });
  });

  it.each([
    [404, 'video_unavailable', false],
    [410, 'video_unavailable', false],
    [401, 'login_required', false],
    [503, 'source_blocked', true],
    [400, 'source_blocked', false],
  ])('turns a %s answer into %s', async (status, code, retryable) => {
    stubSite({ [PAGE_URL]: page('nope', {}, status) });
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code, retryable });
  });

  it.each([403, 429])('leaves a page that answers %s for the model to open itself, at the address it ended at', async (status) => {
    const moved = 'https://www.example.co.il/salad/';
    stubSite({ [PAGE_URL]: redirect(moved), [moved]: page('Access Denied', {}, status) });
    expect(await web.fetchPost(PAGE_URL)).toEqual({
      sourceId: PAGE_URL,
      sourceUrl: PAGE_URL,
      title: 'www.example.co.il',
      text: '',
      transcript: '',
      video: null,
      pageUrl: moved,
    });
  });

  it('refuses a link to a file that is not a page', async () => {
    stubSite({ [PAGE_URL]: page('%PDF-1.7', { 'content-type': 'application/pdf' }) });
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code: 'link_unsupported', retryable: false });
  });

  it('refuses a page too big to be a recipe page', async () => {
    stubSite({ [PAGE_URL]: page('x'.repeat(5 * 1024 * 1024 + 1)) });
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code: 'link_unsupported' });
  });

  it('retries a site that cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Network connection lost.');
    }));
    expect(await failure(web.fetchPost(PAGE_URL))).toMatchObject({ code: 'source_blocked', retryable: true });
  });
});

describe('the Workflow, end to end, for a web page', () => {
  const [FIRST] = env.LLM_IMPORT_MODELS.split(',');
  const EMPTY = { name: '', ingredients: [], steps: [] };
  const ONE = {
    status: 'one',
    language: 'he',
    en: { name: 'Edamame salad', ingredients: ['1 bag edamame'], steps: ['Mix'] },
    he: { name: 'סלט אדממה', ingredients: ['שקית אדממה'], steps: ['לערבב'] },
  };
  const geminiReply = (output) =>
    new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(output) }] }] }));
  const fakeWorld = (site, output = ONE) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url) === PAGE_URL) return site();
        if (String(url).endsWith('/v1beta/interactions')) return geminiReply(output);
        throw new Error(`unexpected request: ${url}`);
      }),
    );
  const webImport = async () =>
    insertImport(await insertUser(), { platform: 'web', source_id: PAGE_URL, source_url: PAGE_URL, quota_day: quotaDay(Date.now()) });
  const reload = (row) => env.DB.prepare('SELECT * FROM llm_requests WHERE id = ?').bind(row.id).first();
  const runWorkflow = async (row) => {
    await using introspector = await introspectWorkflow(env.IMPORT_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
    });
    await env.IMPORT_WORKFLOW.create({ id: `import-${row.id}-1`, params: { importId: row.id, attempt: 1 } });
    const [instance] = await introspector.get();
    await instance.waitForStatus('complete');
  };

  it('imports a recipe page: one page request, one text-only model call, the recipe', async () => {
    fakeWorld(() => page(recipePage()));
    const row = await webImport();
    await runWorkflow(row);

    const after = await reload(row);
    expect(after).toMatchObject({ status: 'done', title: 'Edamame salad - Keren', error: null, model: FIRST });
    const recipe = await env.DB.prepare('SELECT * FROM recipes WHERE id = ?').bind(after.recipe_id).first();
    expect(recipe).toMatchObject({ platform: 'web', source_url: PAGE_URL, name_en: 'Edamame salad', name_he: 'סלט אדממה' });

    const [, modelCall] = fetch.mock.calls;
    const sent = JSON.parse(modelCall[1].body);
    expect(sent.input).toHaveLength(1);
    expect(sent.input[0].text).toContain('There is no video for you to watch');
    expect(sent.input[0].text).toContain(RECIPE_TEXT);
  });

  it('fails with no_recipe when the model finds no recipe on the page', async () => {
    fakeWorld(() => page(recipePage('<p>Our opening hours are Sunday to Thursday, 9 to 5. Call us for orders and deliveries anywhere.</p>')), {
      status: 'none',
      language: 'other',
      en: EMPTY,
      he: EMPTY,
    });
    const row = await webImport();
    await runWorkflow(row);
    expect(await reload(row)).toMatchObject({ status: 'failed', error: 'no_recipe' });
  });

  it('fails with no_recipe, calling no model, when the page has almost no text', async () => {
    fakeWorld(() => page('<html><body><div id="app"></div></body></html>'));
    const row = await webImport();
    await runWorkflow(row);
    expect(await reload(row)).toMatchObject({ status: 'failed', error: 'no_recipe' });
    expect(requested()).toEqual([PAGE_URL]);
  });

  it('has the model open a page that blocks the Worker, with its URL tool and nothing from the page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url) === PAGE_URL) return page('Access Denied', {}, 403);
        return new Response(
          JSON.stringify({
            status: 'completed',
            steps: [
              { type: 'url_context_result', result: [{ url: PAGE_URL, status: 'success' }] },
              { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(ONE) }] },
            ],
          }),
        );
      }),
    );
    const row = await webImport();
    await runWorkflow(row);

    const after = await reload(row);
    expect(after).toMatchObject({ status: 'done', title: 'recipes.example.co.il', error: null, model: FIRST });
    const recipe = await env.DB.prepare('SELECT * FROM recipes WHERE id = ?').bind(after.recipe_id).first();
    expect(recipe).toMatchObject({ platform: 'web', source_url: PAGE_URL, name_en: 'Edamame salad' });

    const [, modelCall] = fetch.mock.calls;
    const sent = JSON.parse(modelCall[1].body);
    expect(sent.tools).toEqual([{ type: 'url_context' }]);
    expect(sent.input).toHaveLength(1);
    expect(sent.input[0].text).toContain(PAGE_URL);
    expect(sent.input[0].text).not.toContain('Access Denied');
  });

  it('fails with source_blocked when the model cannot open the page either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url) === PAGE_URL) return page('Access Denied', {}, 403);
        return new Response(
          JSON.stringify({
            status: 'completed',
            steps: [
              { type: 'url_context_result', result: [{ url: PAGE_URL, status: 'error' }] },
              { type: 'model_output', content: [{ type: 'text', text: '{"status":"none"}' }] },
            ],
          }),
        );
      }),
    );
    const row = await webImport();
    await runWorkflow(row);
    expect(await reload(row)).toMatchObject({ status: 'failed', error: 'source_blocked' });
    // Every model would open it the same way, so only one is asked.
    expect(requested().filter((url) => url.endsWith('/interactions'))).toHaveLength(1);
  });

  it('fails with video_unavailable, calling no model, for a page that does not exist', async () => {
    fakeWorld(() => page('Not found', {}, 404));
    const row = await webImport();
    await runWorkflow(row);
    expect(await reload(row)).toMatchObject({ status: 'failed', error: 'video_unavailable' });
    expect(requested()).toEqual([PAGE_URL]);
  });
});

describe('the endpoints, for a web page', () => {
  let testEnv;
  beforeEach(() => {
    testEnv = { ...env, IMPORT_WORKFLOW: { create: vi.fn(async () => ({ id: 'instance' })) } };
    vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('no external call is expected here');
      }));
  });
  const signUp = async () => {
    const response = await register();
    return { cookie: cookiesFrom(response), userId: (await response.json()).user.id };
  };
  const post = (cookie, path, body = {}) => call(path, { method: 'POST', body, cookie, env: testEnv });

  it('starts an import for a page without fetching it yet', async () => {
    const { cookie } = await signUp();
    const response = await post(cookie, '/api/imports', { url: `${PAGE_URL}?utm_medium=share` });
    expect(response.status).toBe(202);
    expect((await response.json()).import).toMatchObject({ link: PAGE_URL, status: 'running' });
    const row = await env.DB.prepare('SELECT * FROM llm_requests').first();
    expect(row).toMatchObject({ platform: 'web', source_id: PAGE_URL, source_url: PAGE_URL });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a link into a private network before anything starts', async () => {
    const { cookie } = await signUp();
    const response = await post(cookie, '/api/imports', { url: 'http://localhost:8787/api/auth/me' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('link_unsupported');
    expect(testEnv.IMPORT_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it('answers already_imported for a page the user has saved', async () => {
    const { cookie, userId } = await signUp();
    await env.DB.prepare(`INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'web', ?, 'm', 'Salad')`)
      .bind(userId, PAGE_URL)
      .run();
    const response = await post(cookie, '/api/imports', { url: `${PAGE_URL}#top` });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('already_imported');
  });

  it('reads a saved page again from its stored link', async () => {
    const { cookie, userId } = await signUp();
    const recipe = await env.DB.prepare(`INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'web', ?, 'm', 'Salad') RETURNING id`)
      .bind(userId, PAGE_URL)
      .first();
    const response = await post(cookie, `/api/recipes/${recipe.id}/rerun`);
    expect(response.status).toBe(202);
    expect(await env.DB.prepare('SELECT platform, replace_recipe_id FROM llm_requests').first()).toEqual({ platform: 'web', replace_recipe_id: recipe.id });
  });
});
