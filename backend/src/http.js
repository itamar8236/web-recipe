// Small helpers shared by every route.

export function json(body, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}

export const fail = (status, code) => json({ error: code }, status);

// The request's JSON body if it is an object, otherwise null. The JSON content type is
// required because a plain HTML form on another site can't send it, so no other site can
// make a logged-in visitor's browser change their data.
export async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
