// Remembered logins: one `sessions` row per device (see schema.sql). Two long-lived
// cookies: `device` (kept across logouts) and `session` (the secret; only its SHA-256 is
// stored).

const TEN_YEARS = 60 * 60 * 24 * 365 * 10;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function cookie(request, name, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

// The logged-in user for this request, or null. `data_user_id` is whose folders and
// recipes this session works on: the user, or the user the admin is acting as.
export async function getSessionUser(request, env) {
  const token = readCookies(request).session;
  if (!token) return null;
  return env.DB.prepare(
    `SELECT users.id, users.username, users.is_admin,
            COALESCE(sessions.acting_as_user_id, sessions.user_id) AS data_user_id
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first();
}

// Logs the user in on this device, replacing the device's previous session (if any).
// Returns the Set-Cookie headers to send.
export async function startSession(request, env, userId) {
  // Reuse only an id this backend could have made, so a tampered cookie can't put
  // arbitrary text in the table.
  const deviceId = readCookies(request).device;
  const device = /^[0-9a-f]{32}$/.test(deviceId ?? '') ? deviceId : randomHex(16);
  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO sessions (device_id, token_hash, user_id) VALUES (?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE
       SET token_hash = excluded.token_hash, user_id = excluded.user_id, acting_as_user_id = NULL`,
  )
    .bind(device, await sha256Hex(token), userId)
    .run();
  return [cookie(request, 'device', device, TEN_YEARS), cookie(request, 'session', token, TEN_YEARS)];
}

// Logs this device out. The device cookie stays, so the next login reuses the same row.
export async function endSession(request, env) {
  const token = readCookies(request).session;
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return [cookie(request, 'session', '', 0)];
}
