import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { call, cookiesFrom, register } from './helpers.js';

const signUp = async (username) => {
  const response = await register(username);
  return { cookie: cookiesFrom(response), id: (await response.json()).user.id };
};

const signUpAdmin = async () => {
  const admin = await signUp('boss');
  await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(admin.id).run();
  return admin;
};

const impersonate = (cookie, userId) => call('/api/admin/impersonate', { method: 'POST', cookie, body: { userId } });

// The database never lets the admin row go, so lift that rule to empty the table after a test.
afterEach(async () => {
  const { sql } = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users_admin_not_deleted'`).first();
  await env.DB.prepare('DROP TRIGGER users_admin_not_deleted').run();
  await env.DB.prepare('DELETE FROM users WHERE is_admin = 1').run();
  await env.DB.prepare(sql).run();
});

describe('GET /api/admin/users', () => {
  it('lists every other username, A to Z, to the admin', async () => {
    const admin = await signUpAdmin();
    await signUp('noa');
    await signUp('Dana');
    const response = await call('/api/admin/users', { cookie: admin.cookie });
    expect(response.status).toBe(200);
    expect((await response.json()).users.map((u) => u.username)).toEqual(['Dana', 'noa']);
  });

  it('refuses anyone but the admin', async () => {
    await signUpAdmin();
    const dana = await signUp('dana');
    const response = await call('/api/admin/users', { cookie: dana.cookie });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('not_admin');
    expect((await call('/api/admin/users')).status).toBe(401);
  });
});

describe('POST /api/admin/impersonate', () => {
  it('logs the admin in as that user for everything, until logging out', async () => {
    const admin = await signUpAdmin();
    const dana = await signUp('dana');
    const created = await call('/api/recipes', { method: 'POST', cookie: dana.cookie, body: { en: { name: 'Soup', ingredients: [], steps: [] }, he: { name: '', ingredients: [], steps: [] } } });
    expect(created.status).toBe(201);

    const response = await impersonate(admin.cookie, dana.id);
    expect(response.status).toBe(200);
    expect((await response.json()).user).toMatchObject({ id: dana.id, username: 'dana', is_admin: false });

    const me = await (await call('/api/auth/me', { cookie: admin.cookie })).json();
    expect(me.user).toMatchObject({ username: 'dana', is_admin: false });
    const recipes = await (await call('/api/recipes', { cookie: admin.cookie })).json();
    expect(recipes.recipes.map((r) => r.en.name)).toEqual(['Soup']);

    // My account changes dana, not the admin.
    await call('/api/auth/me', { method: 'PUT', cookie: admin.cookie, body: { defaultPublic: false } });
    expect(await env.DB.prepare('SELECT default_public FROM users WHERE id = ?').bind(dana.id).first('default_public')).toBe(0);

    // Acting as dana, the admin page is closed too: no hopping to another user.
    expect((await call('/api/admin/users', { cookie: admin.cookie })).status).toBe(403);

    await call('/api/auth/logout', { method: 'POST', cookie: admin.cookie });
    const again = await call('/api/auth/login', { method: 'POST', cookie: admin.cookie, body: { username: 'boss', password: 'password123' } });
    const back = await (await call('/api/auth/me', { cookie: cookiesFrom(again) })).json();
    expect(back.user).toMatchObject({ username: 'boss', is_admin: true });
  });

  it('refuses anyone but the admin', async () => {
    await signUpAdmin();
    const dana = await signUp('dana');
    const noa = await signUp('noa');
    const response = await impersonate(dana.cookie, noa.id);
    expect(response.status).toBe(403);
    expect((await impersonate(undefined, noa.id)).status).toBe(401);
  });

  it('rejects a bad or unknown user id, and the admin themself', async () => {
    const admin = await signUpAdmin();
    expect((await impersonate(admin.cookie, 'x')).status).toBe(400);
    expect((await impersonate(admin.cookie, 9999)).status).toBe(404);
    expect((await impersonate(admin.cookie, admin.id)).status).toBe(404);
  });
});
