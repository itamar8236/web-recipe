import { env } from 'cloudflare:test';
import worker from '../src/index.js';

export const call = (path, { method = 'GET', body, cookie, env: testEnv = env } = {}) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    testEnv,
  );

// Turns a response's Set-Cookie headers into a Cookie request header, like a browser would.
export const cookiesFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');

export const register = (username = 'dana', password = 'password123') =>
  call('/api/auth/register', { method: 'POST', body: { username, password } });

// A user row, for tests that don't need to log in.
export const insertUser = async (username = 'dana') =>
  (
    await env.DB.prepare(`INSERT INTO users (username, password_hash) VALUES (?, 'pbkdf2-sha256$1$a$b') RETURNING id`)
      .bind(username)
      .first()
  ).id;

// An llm_requests row with sensible defaults; `fields` overrides any column.
export const insertImport = (userId, fields = {}) => {
  const row = {
    user_id: userId,
    platform: 'youtube',
    source_id: 'dQw4w9WgXcQ',
    source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    quota_day: '2026-11-08',
    created_at: 1,
    updated_at: 1,
    ...fields,
  };
  const columns = Object.keys(row);
  return env.DB.prepare(
    `INSERT INTO llm_requests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
  )
    .bind(...Object.values(row))
    .first();
};
