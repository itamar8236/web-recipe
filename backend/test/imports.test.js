import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSource, readLink, SOURCES } from '../src/import/sources/index.js';
import { youtube } from '../src/import/sources/youtube.js';
import { nextQuotaReset, quotaDay } from '../src/import/models.js';
import worker from '../src/index.js';
import { call, cookiesFrom, insertImport, insertUser, register } from './helpers.js';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe('link detection', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=30s&si=abc`,
    `https://www.youtube.com/watch?t=30s&v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/shorts/${ID}/`,
    `https://m.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://youtube.com/live/${ID}?si=xyz`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `  https://youtu.be/${ID}  `,
    `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
  ])('accepts %s and stores the canonical link', (text) => {
    const link = readLink(text);
    expect(link.error).toBeUndefined();
    expect(link.source).toBe(youtube);
    expect(link.sourceId).toBe(ID);
    expect(link.sourceUrl).toBe(CANONICAL);
    expect(new URL(link.sourceUrl).hostname).toBe('www.youtube.com');
  });

  it.each([
    ['a too-short id', 'https://www.youtube.com/watch?v=short'],
    ['a too-long id', `https://www.youtube.com/watch?v=${ID}x`],
    ['bad characters in the id', 'https://www.youtube.com/watch?v=dQw4w9WgXc!'],
    ['a bad short id', 'https://youtu.be/abc'],
    ['no v parameter', 'https://www.youtube.com/watch'],
    ['a channel', 'https://www.youtube.com/@somecook'],
    ['an old channel', 'https://www.youtube.com/channel/UCabcdefghijklmnop'],
    ['a playlist', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['the home page', 'https://www.youtube.com/'],
    ['the short home page', 'https://youtu.be/'],
    ['shorts without an id', 'https://www.youtube.com/shorts/'],
    ['extra path after the id', `https://www.youtube.com/shorts/${ID}/more`],
    ['extra path on youtu.be', `https://youtu.be/${ID}/more`],
    ['text that is not a URL', 'pasta with tomatoes'],
    ['an empty string', ''],
    ['a link with no scheme', `youtube.com/watch?v=${ID}`],
    ['another scheme', `ftp://www.youtube.com/watch?v=${ID}`],
    ['javascript', 'javascript:alert(1)'],
    ['a huge input', `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(3000)}`],
  ])('refuses %s as link_invalid', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_invalid' });
  });

  it.each([
    ['Facebook', 'https://www.facebook.com/watch/?v=1234567890'],
    ['Facebook short', 'https://fb.watch/abcdefg/'],
    ['Instagram', 'https://www.instagram.com/reel/Cabcdefghij/'],
    ['TikTok', 'https://www.tiktok.com/@cook/video/1234567890123456789'],
    ['an unknown site', 'https://example.com/recipe'],
    ['a lookalike host', `https://youtube.com.evil.example/watch?v=${ID}`],
    ['a host that ends the same', `https://notyoutube.com/watch?v=${ID}`],
    ['a subdomain not on the list', `https://music.youtube.com/watch?v=${ID}`],
    ['a user-info trick', `https://youtube.com@evil.example/watch?v=${ID}`],
  ])('refuses %s as link_unsupported', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_unsupported' });
  });

  it('has YouTube as the only source for now, found through detectSource', () => {
    expect(SOURCES).toEqual([youtube]);
    expect(detectSource(new URL(CANONICAL))).toBe(youtube);
    expect(detectSource(new URL('https://example.com/'))).toBeUndefined();
  });
});

describe('video length', () => {
  it.each([
    ['PT3M', 180],
    ['PT12M3S', 723],
    ['PT59S', 59],
    ['PT1H2M3S', 3723],
    ['P1DT1S', 86401],
    ['P1W', 604800],
    ['P0D', 0],
  ])('reads %s as %i seconds', (duration, seconds) => {
    expect(youtube.durationSeconds(duration)).toBe(seconds);
  });

  it.each(['', '3 minutes', 'T3M'])('reads %j as unknown', (duration) => {
    expect(youtube.durationSeconds(duration)).toBeNull();
  });
});

describe('imports table rules', () => {
  it('fills in the defaults a new import needs', async () => {
    const row = await insertImport(await insertUser('dana'));
    expect(row).toMatchObject({ status: 'running', stage: 'meta', attempt: 1, state: '{}', used_best: 0, error: null });
  });

  it('allows only one running import per user and video', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId);
    await expect(insertImport(userId)).rejects.toThrow(/UNIQUE/);
  });

  it('allows the same video again once the first is finished, and for another user', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId, { status: 'failed' });
    await insertImport(userId);
    await insertImport(await insertUser('noa'));
  });

  it('refuses an unknown status and invalid state JSON', async () => {
    const userId = await insertUser('dana');
    await expect(insertImport(userId, { status: 'paused' })).rejects.toThrow(/CHECK/);
    await expect(insertImport(userId, { state: 'not json' })).rejects.toThrow(/CHECK/);
  });

  it('accepts any platform, so a new source needs no table change', async () => {
    const row = await insertImport(await insertUser('dana'), { platform: 'somewhere-new' });
    expect(row.platform).toBe('somewhere-new');
  });

  it('deletes a user’s imports and approval with the user', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId);
    await env.DB.prepare('INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, 1)')
      .bind(userId)
      .run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM imports').first()).n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM llm_basic_model_approvals').first()).n).toBe(0);
  });

  it('keeps an import when its recipe is deleted, and a re-run keeps pointing at it', async () => {
    const userId = await insertUser('dana');
    const recipe = await env.DB.prepare(
      `INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'youtube', ?, 'm', 'Tea') RETURNING id`,
    )
      .bind(userId, CANONICAL)
      .first();
    const row = await insertImport(userId, { recipe_id: recipe.id, replace_recipe_id: recipe.id });
    await env.DB.prepare('DELETE FROM recipes WHERE id = ?').bind(recipe.id).run();
    const after = await env.DB.prepare('SELECT recipe_id, replace_recipe_id FROM imports WHERE id = ?').bind(row.id).first();
    expect(after).toEqual({ recipe_id: null, replace_recipe_id: recipe.id });
  });
});

describe('import endpoints', () => {
  const BEST = env.LLM_BEST_MODEL;
  const BASIC = env.LLM_BASIC_MODEL;
  const LINK = `https://youtu.be/${ID}`;
  const today = () => quotaDay(Date.now());
  const SOON = () => Date.now() + 3600000;

  // A stand-in for the Workflow binding, so these tests never start one.
  let workflow;
  let testEnv;
  beforeEach(() => {
    workflow = { create: vi.fn(async () => ({ id: 'instance' })) };
    testEnv = { ...env, IMPORT_WORKFLOW: workflow };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external call is expected here'); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const signUp = async (name = 'dana') => {
    const response = await register(name);
    return { cookie: cookiesFrom(response), userId: (await response.json()).user.id };
  };
  const send = (cookie, method, path, body) => call(path, { method, body, cookie, env: testEnv });
  const post = (cookie, path, body = {}) => send(cookie, 'POST', path, body);
  const startImport = (cookie, url = LINK, extra = {}) => post(cookie, '/api/imports', { url, ...extra });
  const list = async (cookie) => (await send(cookie, 'GET', '/api/imports')).json();
  const errorOf = async (response) => (await response.json()).error;
  const rows = async () => (await env.DB.prepare('SELECT * FROM imports ORDER BY id').all()).results;

  let videoNumber = 0;
  const otherVideo = (fields = {}) => ({ source_id: `vid${String(++videoNumber).padStart(8, '0')}`, source_url: `https://www.youtube.com/watch?v=vid${videoNumber}`, quota_day: today(), ...fields });
  const failedImport = (userId, fields = {}) =>
    insertImport(userId, { status: 'failed', error: 'llm_error', quota_day: today(), updated_at: Date.now(), ...fields });
  const markOut = (model) => env.DB.prepare('INSERT INTO llm_model_status (model, unavailable_until) VALUES (?, ?)').bind(model, SOON()).run();
  const useUpBest = async (userId, count = 5) => {
    for (let i = 0; i < count; i++) await insertImport(userId, otherVideo({ status: 'done', used_best: 1 }));
  };
  const insertRecipe = async (userId, fields = {}) => {
    const row = { user_id: userId, platform: 'youtube', source_url: CANONICAL, source_model: BASIC, name_en: 'Tea', name_he: 'תה', ...fields };
    const columns = Object.keys(row);
    return env.DB.prepare(`INSERT INTO recipes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`)
      .bind(...Object.values(row))
      .first();
  };
  const approvalOf = (userId) => env.DB.prepare('SELECT approved_until FROM llm_basic_model_approvals WHERE user_id = ?').bind(userId).first();

  describe('login', () => {
    it.each([
      ['POST', '/api/imports'],
      ['GET', '/api/imports'],
      ['POST', '/api/imports/1/retry'],
      ['DELETE', '/api/imports/1'],
      ['POST', '/api/recipes/1/rerun'],
    ])('%s %s needs a session', async (method, path) => {
      const response = await call(path, { method, body: method === 'POST' ? {} : undefined, env: testEnv });
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toBe('not_logged_in');
      expect(workflow.create).not.toHaveBeenCalled();
    });

    it('answers 405 for a wrong method and leaves other paths alone', async () => {
      const { cookie } = await signUp();
      expect((await send(cookie, 'PUT', '/api/imports', {})).status).toBe(405);
      expect((await send(cookie, 'GET', '/api/imports/1')).status).toBe(405);
      expect((await send(cookie, 'GET', '/api/imports/1/retry')).status).toBe(405);
      expect((await send(cookie, 'GET', '/api/recipes/1/rerun')).status).toBe(405);
      expect((await send(cookie, 'GET', '/api/imports/abc')).status).toBe(404);
      expect((await send(cookie, 'GET', '/api/recipes')).status).toBe(200);
    });
  });

  describe('POST /api/imports', () => {
    it('stores the canonical link, starts the Workflow and answers 202 with the card', async () => {
      const { cookie, userId } = await signUp();
      const response = await startImport(cookie, `https://youtube.com/shorts/${ID}?feature=share`);
      expect(response.status).toBe(202);
      const [row] = await rows();
      expect(row).toMatchObject({
        user_id: userId,
        platform: 'youtube',
        source_id: ID,
        source_url: CANONICAL,
        status: 'running',
        stage: 'meta',
        attempt: 1,
        quota_day: today(),
        replace_recipe_id: null,
      });
      expect(workflow.create).toHaveBeenCalledTimes(1);
      expect(workflow.create).toHaveBeenCalledWith({ id: `import-${row.id}-1`, params: { importId: row.id, attempt: 1 } });
      expect((await response.json()).import).toEqual({
        id: row.id,
        status: 'running',
        stage: 'meta',
        link: CANONICAL,
        title: null,
        error: null,
        retryable: false,
        recipeId: null,
        recipeName: null,
      });
    });

    it.each([
      ['no url', {}],
      ['a url that is not text', { url: 42 }],
      ['a useBasicModel that is not true or false', { url: LINK, useBasicModel: 'yes' }],
    ])('refuses %s as invalid_request', async (_, body) => {
      const { cookie } = await signUp();
      const response = await post(cookie, '/api/imports', body);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('invalid_request');
    });

    it('refuses a body that is not JSON', async () => {
      const { cookie } = await signUp();
      const response = await worker.fetch(
        new Request('http://localhost/api/imports', { method: 'POST', headers: { Cookie: cookie }, body: `url=${LINK}` }),
        testEnv,
      );
      expect(response.status).toBe(400);
    });

    it.each([
      ['channel', 'https://www.youtube.com/@cook', 'link_invalid'],
      ['playlist', 'https://www.youtube.com/playlist?list=PL123', 'link_invalid'],
      ['bad id', 'https://youtu.be/abc', 'link_invalid'],
      ['plain text', 'not a link', 'link_invalid'],
      ['Facebook', 'https://www.facebook.com/watch/?v=123', 'link_unsupported'],
      ['Instagram', 'https://www.instagram.com/reel/abc/', 'link_unsupported'],
      ['TikTok', 'https://www.tiktok.com/@a/video/1', 'link_unsupported'],
      ['an unknown site', 'https://example.com/recipe', 'link_unsupported'],
      ['a lookalike host', `https://youtube.com.evil.example/watch?v=${ID}`, 'link_unsupported'],
    ])('refuses %s, with no external call and no row', async (_, url, code) => {
      const { cookie, userId } = await signUp();
      const response = await startImport(cookie, url, { useBasicModel: true });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(code);
      expect(await rows()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(workflow.create).not.toHaveBeenCalled();
      expect(await approvalOf(userId)).toBeNull();
    });

    it('returns the running import with 200 for the same video, in any link form', async () => {
      const { cookie } = await signUp();
      const first = await (await startImport(cookie)).json();
      const again = await startImport(cookie, `https://www.youtube.com/shorts/${ID}`);
      expect(again.status).toBe(200);
      expect((await again.json()).import.id).toBe(first.import.id);
      expect(await rows()).toHaveLength(1);
      expect(workflow.create).toHaveBeenCalledTimes(1);
    });

    it('two users can import the same video at once', async () => {
      expect((await startImport((await signUp('dana')).cookie)).status).toBe(202);
      expect((await startImport((await signUp('noa')).cookie)).status).toBe(202);
    });

    it('answers 409 already_imported when the user has this recipe', async () => {
      const { cookie, userId } = await signUp();
      await insertRecipe(userId);
      const response = await startImport(cookie);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('already_imported');
      expect(await rows()).toEqual([]);
    });

    it('only looks at this user’s recipes, and allows a new import once the recipe is deleted', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      const recipe = await insertRecipe(dana.userId);
      expect((await startImport(noa.cookie)).status).toBe(202);
      await env.DB.prepare('DELETE FROM recipes WHERE id = ?').bind(recipe.id).run();
      expect((await startImport(dana.cookie)).status).toBe(202);
    });

    it('allows up to 3 running, then answers 429 too_many_imports', async () => {
      const { cookie, userId } = await signUp();
      for (let i = 0; i < 3; i++) await insertImport(userId, otherVideo());
      const response = await startImport(cookie);
      expect(response.status).toBe(429);
      expect(await errorOf(response)).toBe('too_many_imports');
      expect(await rows()).toHaveLength(3);
    });

    it('allows a 3rd running import', async () => {
      const { cookie, userId } = await signUp();
      for (let i = 0; i < 2; i++) await insertImport(userId, otherVideo());
      expect((await startImport(cookie)).status).toBe(202);
    });

    it('counts 10 a day including finished and dismissed rows', async () => {
      const { cookie, userId } = await signUp();
      for (let i = 0; i < 9; i++) await insertImport(userId, otherVideo({ status: i % 2 ? 'dismissed' : 'done' }));
      expect((await startImport(cookie)).status).toBe(202);
      expect(await errorOf(await startImport(cookie, `https://youtu.be/aaaaaaaaaaa`))).toBe('too_many_imports');
    });

    it('does not count other days or other users', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      for (let i = 0; i < 10; i++) await insertImport(noa.userId, otherVideo({ status: 'done' }));
      for (let i = 0; i < 10; i++) await insertImport(dana.userId, otherVideo({ status: 'done', quota_day: '2020-01-01' }));
      expect((await startImport(dana.cookie)).status).toBe(202);
    });

    it('checks in the spec’s order: a running duplicate before anything else', async () => {
      const { cookie, userId } = await signUp();
      await insertImport(userId, { quota_day: today() });
      for (let i = 0; i < 2; i++) await insertImport(userId, otherVideo());
      await markOut(BEST);
      expect((await startImport(cookie)).status).toBe(200);
    });

    it('checks already_imported before the caps', async () => {
      const { cookie, userId } = await signUp();
      await insertRecipe(userId);
      for (let i = 0; i < 3; i++) await insertImport(userId, otherVideo());
      expect(await errorOf(await startImport(cookie))).toBe('already_imported');
    });

    it('checks the caps before the model state, and stores no approval when over them', async () => {
      const { cookie, userId } = await signUp();
      await markOut(BEST);
      for (let i = 0; i < 3; i++) await insertImport(userId, otherVideo());
      expect(await errorOf(await startImport(cookie, LINK, { useBasicModel: true }))).toBe('too_many_imports');
      expect(await approvalOf(userId)).toBeNull();
    });

    it('asks first when the best model is out, and runs nothing', async () => {
      const { cookie } = await signUp();
      await markOut(BEST);
      const response = await startImport(cookie);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('model_approval_needed');
      expect(await rows()).toEqual([]);
      expect(workflow.create).not.toHaveBeenCalled();
    });

    it('the 6th best-model import asks first', async () => {
      const { cookie, userId } = await signUp();
      await useUpBest(userId);
      expect(await errorOf(await startImport(cookie))).toBe('model_approval_needed');
    });

    it('useBasicModel stores an approval until the reset, and the import starts', async () => {
      const { cookie, userId } = await signUp();
      await markOut(BEST);
      const before = Date.now();
      const response = await startImport(cookie, LINK, { useBasicModel: true });
      expect(response.status).toBe(202);
      expect((await approvalOf(userId)).approved_until).toBe(nextQuotaReset(before));
      expect(workflow.create).toHaveBeenCalledTimes(1);
    });

    it('a user who already approved needs no flag', async () => {
      const { cookie, userId } = await signUp();
      await markOut(BEST);
      await env.DB.prepare('INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, ?)').bind(userId, SOON()).run();
      expect((await startImport(cookie)).status).toBe(202);
    });

    it('answers 429 quota when both models are out', async () => {
      const { cookie } = await signUp();
      await markOut(BEST);
      await markOut(BASIC);
      const response = await startImport(cookie, LINK, { useBasicModel: true });
      expect(response.status).toBe(429);
      expect(await errorOf(response)).toBe('quota');
      expect(await rows()).toEqual([]);
    });

    describe('when another request starts the same video at the same moment', () => {
      // The database refuses the INSERT, as it would if the other request got there first.
      const conflictingDb = (beforeRefusing) =>
        new Proxy(env.DB, {
          get(target, name) {
            if (name !== 'prepare') return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
            return (sql) => {
              if (!sql.startsWith('INSERT INTO imports')) return target.prepare(sql);
              return {
                bind: () => ({
                  first: async () => {
                    await beforeRefusing();
                    throw new Error('UNIQUE constraint failed: imports.user_id');
                  },
                }),
              };
            };
          },
        });

      it('answers 200 with the import that got there first', async () => {
        const { cookie, userId } = await signUp();
        testEnv.DB = conflictingDb(() => insertImport(userId, { quota_day: today(), updated_at: Date.now() }));
        const response = await startImport(cookie);
        expect(response.status).toBe(200);
        expect((await response.json()).import.link).toBe(CANONICAL);
        expect(workflow.create).not.toHaveBeenCalled();
      });

      it('answers already_imported when that import has already finished', async () => {
        const { cookie } = await signUp();
        testEnv.DB = conflictingDb(async () => {});
        const response = await startImport(cookie);
        expect(response.status).toBe(409);
        expect(await errorOf(response)).toBe('already_imported');
      });
    });

    it('marks the row failed with llm_error when the Workflow cannot start', async () => {
      const { cookie } = await signUp();
      workflow.create.mockRejectedValueOnce(new Error('workflow.not_found'));
      const response = await startImport(cookie);
      expect(response.status).toBe(202);
      expect((await response.json()).import).toMatchObject({ status: 'failed', error: 'llm_error', retryable: true });
      expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', error: 'llm_error' })]);
    });

    it('acts for the user the admin is impersonating', async () => {
      const admin = await signUp('admin');
      const target = await signUp('target');
      await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(admin.userId).run();
      await env.DB.prepare('UPDATE sessions SET acting_as_user_id = ? WHERE user_id = ?').bind(target.userId, admin.userId).run();
      await startImport(admin.cookie);
      expect((await rows())[0].user_id).toBe(target.userId);

      // The database never lets the admin row go, so lift that rule to clean up after this test.
      const { sql } = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users_admin_not_deleted'`).first();
      await env.DB.prepare('DROP TRIGGER users_admin_not_deleted').run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(admin.userId).run();
      await env.DB.prepare(sql).run();
    });
  });

  describe('GET /api/imports', () => {
    it('lists running, failed and done, newest first, and never dismissed or state', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId);
      const done = await insertImport(userId, otherVideo({ status: 'done', recipe_id: recipe.id, title: 'A video', updated_at: Date.now() }));
      const failed = await failedImport(userId, otherVideo());
      await insertImport(userId, otherVideo({ status: 'dismissed' }));
      const running = await insertImport(userId, otherVideo({ stage: 'extract', updated_at: Date.now(), state: '{"meta":{"description":"secret text"}}' }));

      const response = await send(cookie, 'GET', '/api/imports');
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('secret text');
      const { imports } = JSON.parse(text);
      expect(imports.map((i) => i.id)).toEqual([running.id, failed.id, done.id]);
      expect(imports[0]).not.toHaveProperty('state');
      expect(imports[0]).toMatchObject({ status: 'running', stage: 'extract', recipeName: null });
      expect(imports[2]).toMatchObject({ status: 'done', title: 'A video', recipeId: recipe.id, recipeName: { en: 'Tea', he: 'תה' } });
    });

    it('shows only this user’s imports', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      await insertImport(dana.userId, otherVideo({ updated_at: Date.now() }));
      expect((await list(noa.cookie)).imports).toEqual([]);
      expect((await list(dana.cookie)).imports).toHaveLength(1);
    });

    it('returns the model state', async () => {
      const { cookie, userId } = await signUp();
      await useUpBest(userId, 2);
      const before = Date.now();
      const { models } = await list(cookie);
      expect(models).toMatchObject({ bestAvailable: true, bestLeftToday: 20, bestLeftForUser: 3, basicModel: BASIC, basicApproved: false, bestAvailableAt: null });
      expect(models.resetsAt).toBeGreaterThanOrEqual(nextQuotaReset(before));
      expect(Object.keys(models).sort()).toEqual(['basicApproved', 'basicModel', 'bestAvailable', 'bestAvailableAt', 'bestLeftForUser', 'bestLeftToday', 'resetsAt']);
    });

    it.each([
      ['video_unavailable', false],
      ['video_private', false],
      ['video_too_long', false],
      ['no_recipe', false],
      ['multiple_recipes', false],
      ['llm_error', true],
      ['bad_result', true],
      ['model_approval_needed', true],
      ['quota', true],
      ['timed_out', true],
    ])('a failure with %s has retryable = %s', async (error, retryable) => {
      const { cookie, userId } = await signUp();
      await failedImport(userId, { error });
      expect((await list(cookie)).imports[0]).toMatchObject({ status: 'failed', error, retryable });
    });

    it('hides the error of a try that is about to be repeated', async () => {
      const { cookie, userId } = await signUp();
      await insertImport(userId, { error: 'bad_result', updated_at: Date.now(), quota_day: today() });
      expect((await list(cookie)).imports[0]).toMatchObject({ status: 'running', error: null, retryable: false });
    });

    it('marks a running import with no update for 30 minutes as timed_out', async () => {
      const { cookie, userId } = await signUp();
      const stuck = await insertImport(userId, otherVideo({ updated_at: Date.now() - 31 * 60 * 1000 }));
      const fresh = await insertImport(userId, otherVideo({ updated_at: Date.now() - 29 * 60 * 1000 }));
      const { imports } = await list(cookie);
      expect(imports.find((i) => i.id === stuck.id)).toMatchObject({ status: 'failed', error: 'timed_out', retryable: true });
      expect(imports.find((i) => i.id === fresh.id)).toMatchObject({ status: 'running' });
    });

    it('leaves another user’s stuck import alone', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      const stuck = await insertImport(noa.userId, otherVideo({ updated_at: 1 }));
      await list(dana.cookie);
      expect((await env.DB.prepare('SELECT status FROM imports WHERE id = ?').bind(stuck.id).first()).status).toBe('running');
    });
  });

  describe('POST /api/imports/:id/retry', () => {
    const retry = (cookie, id, body = {}) => post(cookie, `/api/imports/${id}/retry`, body);
    const reload = (row) => env.DB.prepare('SELECT * FROM imports WHERE id = ?').bind(row.id).first();

    it('bumps the attempt, restarts the import and keeps its state', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { state: '{"done":["meta"],"meta":{}}', stage: 'extract' });
      const response = await retry(cookie, row.id);
      expect(response.status).toBe(202);
      expect((await response.json()).import).toMatchObject({ id: row.id, status: 'running', error: null, stage: 'extract' });
      expect(await reload(row)).toMatchObject({ status: 'running', attempt: 2, error: null, state: '{"done":["meta"],"meta":{}}' });
      expect(workflow.create).toHaveBeenCalledWith({ id: `import-${row.id}-2`, params: { importId: row.id, attempt: 2 } });
    });

    it('answers 404 for another user’s import and for a missing one', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      const row = await failedImport(dana.userId);
      expect((await retry(noa.cookie, row.id)).status).toBe(404);
      expect((await retry(noa.cookie, 987654)).status).toBe(404);
      expect((await reload(row)).status).toBe('failed');
    });

    it.each([
      ['running', { status: 'running', error: null }],
      ['done', { status: 'done', error: null }],
      ['dismissed', { status: 'dismissed', error: 'llm_error' }],
      ['failed for good', { status: 'failed', error: 'no_recipe' }],
    ])('answers 409 not_retryable when it is %s', async (_, fields) => {
      const { cookie, userId } = await signUp();
      const row = await insertImport(userId, { quota_day: today(), ...fields });
      const response = await retry(cookie, row.id);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('not_retryable');
      expect(workflow.create).not.toHaveBeenCalled();
    });

    it('restarts only once on a double tap', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      expect((await retry(cookie, row.id)).status).toBe(202);
      expect(await errorOf(await retry(cookie, row.id))).toBe('not_retryable');
      expect(workflow.create).toHaveBeenCalledTimes(1);
    });

    it('answers not_retryable when the same video is already running', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      await insertImport(userId, { quota_day: today(), updated_at: Date.now() });
      expect(await errorOf(await retry(cookie, row.id))).toBe('not_retryable');
      expect((await reload(row)).status).toBe('failed');
    });

    it('answers not_retryable when the recipe has been saved since', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      await insertRecipe(userId);
      expect(await errorOf(await retry(cookie, row.id))).toBe('not_retryable');
    });

    it('asks first when the best model is out', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { error: 'model_approval_needed' });
      await markOut(BEST);
      const response = await retry(cookie, row.id);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('model_approval_needed');
      expect(await reload(row)).toMatchObject({ status: 'failed', attempt: 1 });
    });

    it('with useBasicModel stores the approval and restarts', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { error: 'model_approval_needed' });
      await markOut(BEST);
      expect((await retry(cookie, row.id, { useBasicModel: true })).status).toBe(202);
      expect(await approvalOf(userId)).not.toBeNull();
    });

    it('answers 429 quota when both models are out', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { error: 'quota' });
      await markOut(BEST);
      await markOut(BASIC);
      const response = await retry(cookie, row.id, { useBasicModel: true });
      expect(response.status).toBe(429);
      expect(await errorOf(response)).toBe('quota');
    });

    it('does not use another of the 5: an import holding one can retry at the cap', async () => {
      const { cookie, userId } = await signUp();
      await useUpBest(userId, 4);
      const row = await failedImport(userId, { used_best: 1 });
      expect((await retry(cookie, row.id)).status).toBe(202);
      expect(await reload(row)).toMatchObject({ used_best: 1, quota_day: today() });
    });

    it('needs no model when the recipe was already extracted', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { state: '{"model":"m","recipe":{},"done":["meta","extract"]}', stage: 'save' });
      await markOut(BEST);
      await markOut(BASIC);
      expect((await retry(cookie, row.id)).status).toBe(202);
    });

    it('on a later day counts against that day', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId, { used_best: 1, quota_day: '2020-01-01' });
      expect((await retry(cookie, row.id)).status).toBe(202);
      expect(await reload(row)).toMatchObject({ used_best: 0, quota_day: today() });
    });

    it('on a later day cannot pass the user’s cap as if it already held a use', async () => {
      const { cookie, userId } = await signUp();
      await useUpBest(userId);
      const row = await failedImport(userId, { used_best: 1, quota_day: '2020-01-01' });
      expect(await errorOf(await retry(cookie, row.id))).toBe('model_approval_needed');
    });

    it('marks the row failed when the Workflow cannot start', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      workflow.create.mockRejectedValueOnce(new Error('nope'));
      const response = await retry(cookie, row.id);
      expect((await response.json()).import).toMatchObject({ status: 'failed', error: 'llm_error' });
    });

    it('refuses a useBasicModel that is not true or false', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      expect((await retry(cookie, row.id, { useBasicModel: 1 })).status).toBe(400);
    });

    describe('of a re-run', () => {
      it('answers quota and stores no approval when the best model is out', async () => {
        const { cookie, userId } = await signUp();
        const recipe = await insertRecipe(userId);
        const row = await failedImport(userId, { error: 'quota', replace_recipe_id: recipe.id });
        await markOut(BEST);
        const response = await retry(cookie, row.id, { useBasicModel: true });
        expect(response.status).toBe(429);
        expect(await errorOf(response)).toBe('quota');
        expect(await approvalOf(userId)).toBeNull();
      });

      it('restarts when the best model is back, even though the recipe exists', async () => {
        const { cookie, userId } = await signUp();
        const recipe = await insertRecipe(userId);
        const row = await failedImport(userId, { error: 'quota', replace_recipe_id: recipe.id });
        expect((await retry(cookie, row.id)).status).toBe(202);
      });

      it('answers not_retryable when the recipe was deleted', async () => {
        const { cookie, userId } = await signUp();
        const row = await failedImport(userId, { error: 'quota', replace_recipe_id: 4242 });
        expect(await errorOf(await retry(cookie, row.id))).toBe('not_retryable');
      });
    });
  });

  describe('DELETE /api/imports/:id', () => {
    const dismiss = (cookie, id) => send(cookie, 'DELETE', `/api/imports/${id}`);

    it('dismisses the card, and the row stays for the daily cap', async () => {
      const { cookie, userId } = await signUp();
      const row = await failedImport(userId);
      const response = await dismiss(cookie, row.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await list(cookie)).imports).toEqual([]);
      expect((await rows())[0].status).toBe('dismissed');
    });

    it('can be repeated, and frees the video to run again', async () => {
      const { cookie, userId } = await signUp();
      const row = await insertImport(userId, { quota_day: today(), updated_at: Date.now() });
      expect((await dismiss(cookie, row.id)).status).toBe(200);
      expect((await dismiss(cookie, row.id)).status).toBe(200);
      expect((await startImport(cookie)).status).toBe(202);
    });

    it('answers 404 for another user’s import and for a missing one', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      const row = await failedImport(dana.userId);
      expect((await dismiss(noa.cookie, row.id)).status).toBe(404);
      expect((await dismiss(noa.cookie, 987654)).status).toBe(404);
      expect((await rows())[0].status).toBe('failed');
    });
  });

  describe('POST /api/recipes/:id/rerun', () => {
    const rerun = (cookie, id) => post(cookie, `/api/recipes/${id}/rerun`);

    it('starts a re-run of a basic-model recipe', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId);
      const response = await rerun(cookie, recipe.id);
      expect(response.status).toBe(202);
      const [row] = await rows();
      expect(row).toMatchObject({ replace_recipe_id: recipe.id, source_id: ID, source_url: CANONICAL, platform: 'youtube', status: 'running' });
      expect(workflow.create).toHaveBeenCalledWith({ id: `import-${row.id}-1`, params: { importId: row.id, attempt: 1 } });
      expect((await response.json()).import.id).toBe(row.id);
    });

    it('answers 404 for another user’s recipe and for a missing one', async () => {
      const dana = await signUp('dana');
      const noa = await signUp('noa');
      const recipe = await insertRecipe(dana.userId);
      expect((await rerun(noa.cookie, recipe.id)).status).toBe(404);
      expect((await rerun(noa.cookie, 987654)).status).toBe(404);
    });

    it('answers 409 not_rerunnable for a best-model recipe', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId, { source_model: BEST });
      const response = await rerun(cookie, recipe.id);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe('not_rerunnable');
    });

    it('answers 409 not_rerunnable for a manual recipe', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId, { platform: 'manual', source_url: null, source_model: null });
      expect(await errorOf(await rerun(cookie, recipe.id))).toBe('not_rerunnable');
    });

    it('answers 409 not_rerunnable while the same video is already running', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId);
      await insertImport(userId, { quota_day: today(), updated_at: Date.now() });
      expect(await errorOf(await rerun(cookie, recipe.id))).toBe('not_rerunnable');
    });

    it.each([
      ['the best model is out', async () => markOut(BEST)],
      ['the shared limit is reached', async () => env.DB.prepare('INSERT INTO llm_usage (day, model, calls) VALUES (?, ?, 20)').bind(today(), BEST).run()],
    ])('answers 429 best_model_unavailable when %s', async (_, arrange) => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId);
      await arrange();
      const response = await rerun(cookie, recipe.id);
      expect(response.status).toBe(429);
      expect(await errorOf(response)).toBe('best_model_unavailable');
      expect(await rows()).toEqual([]);
    });

    it('answers 429 best_model_unavailable when the user has used their 5', async () => {
      const { cookie, userId } = await signUp();
      const recipe = await insertRecipe(userId);
      await useUpBest(userId);
      expect(await errorOf(await rerun(cookie, recipe.id))).toBe('best_model_unavailable');
    });
  });

  describe('recipes report their source model', () => {
    it('gives the model of an imported recipe and null for a manual one', async () => {
      const { cookie, userId } = await signUp();
      const imported = await insertRecipe(userId);
      const created = await post(cookie, '/api/recipes', {
        folderId: null,
        en: { name: 'Manual', ingredients: [], steps: [] },
        he: { name: '', ingredients: [], steps: [] },
      });
      const manual = (await created.json()).recipe;
      expect(manual.sourceModel).toBeNull();
      const loaded = await (await send(cookie, 'GET', `/api/recipes/${imported.id}`)).json();
      expect(loaded.recipe.sourceModel).toBe(BASIC);
    });
  });
});
