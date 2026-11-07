import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { hashPassword, verifyPassword } from '../src/password.js';

const call = (path, { method = 'GET', body, cookie } = {}) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

// Turns a response's Set-Cookie headers into a Cookie request header, like a browser would.
const cookiesFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');

const register = (username = 'dana', password = 'password123') =>
  call('/api/auth/register', { method: 'POST', body: { username, password } });

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
