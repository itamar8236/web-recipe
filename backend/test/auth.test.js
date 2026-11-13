import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { call, cookiesFrom, insertImport, register } from './helpers.js';

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('secret-pass');
    expect(stored).toMatch(/^pbkdf2-sha256\$\d+\$/);
    expect(await verifyPassword('secret-pass', stored)).toBe(true);
    expect(await verifyPassword('other-pass', stored)).toBe(false);
  });
});

describe('register', () => {
  it('creates the user, logs them in and never stores the plain password', async () => {
    const response = await register('Dana', 'password123');
    expect(response.status).toBe(201);
    expect((await response.json()).user).toMatchObject({ username: 'Dana', is_admin: false });

    const row = await env.DB.prepare('SELECT password_hash FROM users').first();
    expect(row.password_hash).not.toContain('password123');

    const me = await call('/api/auth/me', { cookie: cookiesFrom(response) });
    expect((await me.json()).user.username).toBe('Dana');
  });

  it('rejects bad input', async () => {
    expect((await register('   ', 'password123')).status).toBe(400);
    expect((await register('a'.repeat(51), 'password123')).status).toBe(400);
    expect((await register('dana', '')).status).toBe(400);
    expect((await register('dana', 'x'.repeat(201))).status).toBe(400);
    const notJson = await worker.fetch(
      new Request('http://localhost/api/auth/register', { method: 'POST', body: 'nope' }),
      env,
    );
    expect(notJson.status).toBe(400);
  });

  it('refuses a JSON body sent as a plain form (another site posting it)', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ username: 'dana', password: 'password123' }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    expect(count).toBe(0);
  });

  it('rejects a taken username, ignoring case', async () => {
    await register('dana');
    const again = await register('DANA');
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('username_taken');
  });

  it('stops at 50 users', async () => {
    const hash = await hashPassword('password123');
    const inserts = Array.from({ length: 50 }, (_, i) =>
      env.DB.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').bind(`u${i}`, hash),
    );
    await env.DB.batch(inserts);
    const response = await register('one-too-many');
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('user_limit');
  });
});

describe('login', () => {
  it('logs in with the right password, ignoring username case', async () => {
    await register('dana', 'password123');
    const response = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'DANA', password: 'password123' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join()).toContain('HttpOnly');
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    await register('dana', 'password123');
    const wrong = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'dana', password: 'wrong-password' },
    });
    const unknown = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'nobody', password: 'password123' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('does not accept a longer password that starts with the real one', async () => {
    const real = 'p'.repeat(200);
    await register('dana', real);
    const response = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'dana', password: `${real}extra` },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a body without a username and password', async () => {
    const response = await call('/api/auth/login', { method: 'POST', body: { username: 'dana' } });
    expect(response.status).toBe(400);
  });

  it('keeps one session row per device', async () => {
    const first = await register('dana', 'password123');
    const device = cookiesFrom(first).split('; ').find((c) => c.startsWith('device='));
    for (let i = 0; i < 2; i++) {
      await call('/api/auth/login', {
        method: 'POST',
        body: { username: 'dana', password: 'password123' },
        cookie: device,
      });
    }
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first();
    expect(count).toBe(1);
  });

  it('ignores a tampered device cookie and makes a fresh device id', async () => {
    await register('dana', 'password123');
    const response = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'dana', password: 'password123' },
      cookie: `device=${'z'.repeat(5000)}`,
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare('SELECT device_id FROM sessions WHERE user_id IS NOT NULL').first();
    expect(row.device_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('session', () => {
  it('stays logged in with the cookies and is logged out after logout', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/auth/me', { cookie })).status).toBe(200);

    const out = await call('/api/auth/logout', { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect((await call('/api/auth/me', { cookie })).status).toBe(401);
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first();
    expect(count).toBe(0);
  });

  it('logs out a user who has import and translation rows, keeping their rows', async () => {
    const response = await register();
    const cookie = cookiesFrom(response);
    const userId = (await response.json()).user.id;
    await insertImport(userId, { status: 'failed', error: 'llm_error' });
    await insertImport(userId, { purpose: 'translation', platform: null, source_id: null, source_url: null, status: 'done', used_best: 1 });

    const out = await call('/api/auth/logout', { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.getSetCookie().some((c) => c.startsWith('session=;'))).toBe(true);
    expect((await call('/api/auth/me', { cookie })).status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM llm_requests WHERE user_id = ?').bind(userId).first()).n).toBe(2);
  });

  it('logs out with a JSON body too, and twice in a row', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/auth/logout', { method: 'POST', cookie, body: {} })).status).toBe(200);
    expect((await call('/api/auth/logout', { method: 'POST', cookie })).status).toBe(200);
  });

  it('requires a login for everything except the auth endpoints', async () => {
    expect((await call('/api/auth/me')).status).toBe(401);
    expect((await call('/api/anything')).status).toBe(401);
    expect((await call('/api/auth/me', { cookie: 'session=forged' })).status).toBe(401);
  });

  it('logs the user out when they are deleted', async () => {
    const cookie = cookiesFrom(await register());
    await env.DB.prepare('DELETE FROM users').run();
    expect((await call('/api/auth/me', { cookie })).status).toBe(401);
  });

  it('answers 404 for unknown paths when logged in', async () => {
    const cookie = cookiesFrom(await register());
    expect((await call('/api/nope', { cookie })).status).toBe(404);
  });
});

describe('edit my account', () => {
  const login = (username, password, cookie) =>
    call('/api/auth/login', { method: 'POST', body: { username, password }, cookie });
  const updateMe = (body, cookie) => call('/api/auth/me', { method: 'PUT', body, cookie });

  it('changes the username', async () => {
    const cookie = cookiesFrom(await register('dana', 'password123'));
    const response = await updateMe({ username: ' Dana Levi ' }, cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).user.username).toBe('Dana Levi');
    expect((await login('dana levi', 'password123')).status).toBe(200);
  });

  it('changes the password and keeps every device logged in', async () => {
    const here = cookiesFrom(await register('dana', 'password123'));
    const other = cookiesFrom(await login('dana', 'password123'));
    expect((await updateMe({ password: 'new-pass', username: 'dana2' }, here)).status).toBe(200);

    expect((await call('/api/auth/me', { cookie: here })).status).toBe(200);
    expect((await (await call('/api/auth/me', { cookie: other })).json()).user.username).toBe('dana2');
    expect((await login('dana2', 'password123')).status).toBe(401);
    expect((await login('dana2', 'new-pass')).status).toBe(200);
  });

  it('rejects bad input and a taken username', async () => {
    await register('noa');
    const cookie = cookiesFrom(await register('dana'));
    expect((await updateMe({}, cookie)).status).toBe(400);
    expect((await updateMe({ username: 5 }, cookie)).status).toBe(400);
    expect((await (await updateMe({ username: '  ' }, cookie)).json()).error).toBe('username_invalid');
    expect((await (await updateMe({ password: '' }, cookie)).json()).error).toBe('password_invalid');
    const taken = await updateMe({ username: 'NOA' }, cookie);
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe('username_taken');
  });

  it('requires a login', async () => {
    expect((await updateMe({ username: 'x' })).status).toBe(401);
  });
});
