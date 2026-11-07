import { env } from 'cloudflare:test';
import worker from '../src/index.js';

export const call = (path, { method = 'GET', body, cookie } = {}) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
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
