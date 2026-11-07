import { hashPassword, verifyPassword } from './password.js';
import { endSession, getSessionUser, startSession } from './session.js';

const MAX_USERS = 50;
const MIN_PASSWORD = 1;
const MAX_PASSWORD = 200;

function json(body, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}

const fail = (status, code) => json({ error: code }, status);

function publicUser(user) {
  return { id: user.id, username: user.username, is_admin: user.is_admin === 1 };
}

// Reads { username, password } from the body. Returns null if it isn't a JSON object of strings.
async function readCredentials(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string') return null;
  return { username: body.username.trim(), password: body.password };
}

// Compared against when the username does not exist, so a missing user takes as long to
// reject as a wrong password and the response time does not reveal which usernames exist.
let dummyHash;

async function login(request, env) {
  const credentials = await readCredentials(request);
  if (!credentials) return fail(400, 'invalid_request');

  const user = await env.DB.prepare(
    'SELECT id, username, is_admin, password_hash FROM users WHERE username = ?',
  )
    .bind(credentials.username)
    .first();
  dummyHash ??= await hashPassword('dummy');
  const ok = await verifyPassword(
    credentials.password.slice(0, MAX_PASSWORD),
    user ? user.password_hash : dummyHash,
  );
  if (!user || !ok) return fail(401, 'invalid_credentials');

  return json({ user: publicUser(user) }, 200, await startSession(request, env, user.id));
}

async function register(request, env) {
  const credentials = await readCredentials(request);
  if (!credentials) return fail(400, 'invalid_request');
  const { username, password } = credentials;
  if (username.length < 1 || username.length > 50) return fail(400, 'username_invalid');
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return fail(400, 'password_invalid');

  // The cap is part of the INSERT so two sign-ups at once cannot both take the last slot.
  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO users (username, password_hash, created_at)
       SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM users) < ?
       RETURNING id, username, is_admin`,
    )
      .bind(username, await hashPassword(password), Date.now(), MAX_USERS)
      .first();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return fail(409, 'username_taken');
    throw error;
  }
  if (!row) return fail(403, 'user_limit');

  return json({ user: publicUser(row) }, 201, await startSession(request, env, row.id));
}

async function logout(request, env) {
  return json({ ok: true }, 200, await endSession(request, env));
}

async function handleApi(request, env, path) {
  const method = request.method;

  // Public: the only endpoints that work without a session.
  if (method === 'POST' && path === '/api/auth/login') return login(request, env);
  if (method === 'POST' && path === '/api/auth/register') return register(request, env);
  if (method === 'POST' && path === '/api/auth/logout') return logout(request, env);

  const user = await getSessionUser(request, env);
  if (!user) return fail(401, 'not_logged_in');

  if (method === 'GET' && path === '/api/auth/me') return json({ user: publicUser(user) });

  return fail(404, 'not_found');
}

export default {
  async fetch(request, env) {
    try {
      return await handleApi(request, env, new URL(request.url).pathname);
    } catch (error) {
      console.error(error);
      return fail(500, 'server_error');
    }
  },
};
