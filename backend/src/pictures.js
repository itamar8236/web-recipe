// A recipe's one picture: the only module that reads or writes picture bytes. Pictures are
// stored resized in D1 (recipe_pictures), a full one for the recipe's page and a small
// thumb for the Home and Browse cards, so a view never resizes anything.
//
// Where a picture comes from (recipe_pictures.origin):
//   'link'  an import's thumbnail or preview image, fetched and resized here by the
//           Images binding. A re-scan of the link may replace it.
//   'photo' the photo a photo import read, resized in the browser.
//   'user'  chosen in the edit form, resized in the browser.

import { fail, json } from './http.js';
import { decodeEntities } from './import/sources/meta.js';
import { isFetchableUrl } from './import/sources/web.js';

// The schema's CHECKs, repeated so a bad upload gets a clear answer instead of a SQL error.
export const MAX_FULL_BYTES = 1000000;
export const MAX_THUMB_BYTES = 100000;
const TYPES = new Set(['image/jpeg', 'image/webp']);

// A link picture is resized so its longer side is at most this, and its thumb so its
// shorter side is this: the card crops the thumb to a square, at 64 px on a 3x screen.
const FULL_SIDE = 1280;
const THUMB_SIDE = 240;
const JPEG_QUALITY = 80;

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_REDIRECTS = 5;
const PICTURE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'image/webp,image/jpeg,image/png,image/*;q=0.8',
};
// Types the Images binding reads. SVG is left out: it is a document, not a photo.
const SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

// ---- Reading a picture's address from a page ----

const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
// The preview image sites set for link previews, best first.
const PREVIEW_KEYS = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];

// The page's preview image (og:image, or twitter:image) as an absolute http(s) address,
// or null. Only the page's head part is read, attributes in any order.
export function previewImageUrl(html, pageUrl) {
  const found = new Map();
  for (const [tag] of html.slice(0, 300000).matchAll(META_TAG)) {
    const attributes = {};
    for (const [, name, double, single, bare] of tag.matchAll(ATTRIBUTE)) {
      attributes[name.toLowerCase()] = double ?? single ?? bare;
    }
    const key = (attributes.property ?? attributes.name ?? '').toLowerCase();
    if (PREVIEW_KEYS.includes(key) && attributes.content && !found.has(key)) found.set(key, attributes.content);
  }
  for (const key of PREVIEW_KEYS) {
    if (!found.has(key)) continue;
    try {
      const url = new URL(decodeEntities(found.get(key)).trim(), pageUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // Not an address: try the next one.
    }
  }
  return null;
}

// ---- Fetching and resizing a link's picture ----

async function readCapped(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_SOURCE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SOURCE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

// The picture's bytes, or null with the reason logged. Redirects are followed by hand and
// every hop must pass isFetchableUrl, like a web page's (backend/README.md → Web pages).
async function fetchPicture(address) {
  let url = new URL(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(url)) return skip(`not a public address: ${url.protocol}//${url.host}`);
    let response;
    try {
      response = await fetch(url, { headers: PICTURE_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      return skip(`${url.hostname} request failed: ${error.name}`);
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !response.body || !SOURCE_TYPES.has(type)) {
      await response.body?.cancel();
      return skip(`${url.hostname} answered ${response.status} ${type}`);
    }
    const bytes = await readCapped(response);
    return bytes ?? skip(`the picture is over ${MAX_SOURCE_BYTES} bytes`);
  }
  return skip('too many redirects');
}

function skip(reason) {
  console.log(`No picture: ${reason}`);
  return null;
}

const streamOf = (bytes) => new Response(bytes).body;

async function toJpeg(env, bytes, width) {
  const result = await env.IMAGES.input(streamOf(bytes))
    .transform({ width })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  return new Uint8Array(await result.response().arrayBuffer());
}

// Any picture's bytes as { full, thumb, type } JPEGs, by Cloudflare's Images binding (the
// Worker itself can't decode an image in its CPU time). Never enlarges a picture.
export async function resize(env, bytes) {
  const { width, height } = await env.IMAGES.info(streamOf(bytes));
  if (!width || !height) throw new Error('The picture has no size');
  const fullScale = Math.min(1, FULL_SIDE / Math.max(width, height));
  const thumbScale = Math.min(1, THUMB_SIDE / Math.min(width, height));
  const full = await toJpeg(env, bytes, Math.max(1, Math.round(width * fullScale)));
  const thumb = await toJpeg(env, bytes, Math.max(1, Math.round(width * thumbScale)));
  if (full.byteLength > MAX_FULL_BYTES || thumb.byteLength > MAX_THUMB_BYTES) throw new Error('The resized picture is too big');
  return { full, thumb, type: 'image/jpeg' };
}

// The first of a link's picture addresses that can be fetched and resized, as
// { full, thumb, type }, or null. Never throws: a recipe without a picture is fine.
// Used by the import's picture step, and reusable by a backfill.
export async function pictureForLink(env, addresses) {
  for (const address of addresses ?? []) {
    try {
      const bytes = await fetchPicture(address);
      if (bytes) return await resize(env, bytes);
    } catch (error) {
      skip(`${error.name}: ${error.message}`);
    }
  }
  return null;
}

// ---- Storing ----

// Saves a picture as the recipe's, if the recipe is the user's. A 'link' picture never
// replaces one the user chose or a photo import's photo.
export function savePictureStatement(env, { recipeId, userId, picture, origin, now = Date.now() }) {
  return env.DB.prepare(
    `INSERT INTO recipe_pictures (recipe_id, full, thumb, type, origin, updated_at)
     SELECT id, ?3, ?4, ?5, ?6, ?7 FROM recipes WHERE id = ?1 AND user_id = ?2
     ON CONFLICT (recipe_id) DO UPDATE SET full = excluded.full, thumb = excluded.thumb, type = excluded.type,
       origin = excluded.origin, updated_at = excluded.updated_at
     WHERE excluded.origin <> 'link' OR recipe_pictures.origin = 'link'`,
  ).bind(recipeId, userId, picture.full, picture.thumb, picture.type, origin, now);
}

// Copies a picture from one recipe to another (a copy from Browse), as it is.
export const copyPictureStatement = (env, fromRecipeId, toRecipeId, now = Date.now()) =>
  env.DB.prepare(
    `INSERT OR REPLACE INTO recipe_pictures (recipe_id, full, thumb, type, origin, updated_at)
     SELECT ?2, full, thumb, type, origin, ?3 FROM recipe_pictures WHERE recipe_id = ?1`,
  ).bind(fromRecipeId, toRecipeId, now);

// The recipe JSON's `picture`: the addresses the browser loads, which change with every
// new picture (?v=), so they can be cached for good. picture_at is RECIPE_PICTURE_AT.
export const RECIPE_PICTURE_AT = (alias) => `(SELECT updated_at FROM recipe_pictures WHERE recipe_id = ${alias}.id) AS picture_at`;

export function pictureUrls(recipeId, pictureAt) {
  if (pictureAt === null || pictureAt === undefined) return null;
  const url = `/api/recipes/${recipeId}/picture?v=${pictureAt}`;
  return { url, thumb: `${url}&size=thumb` };
}

// ---- Uploads from the browser ----

// Whether the bytes really are the type they claim, so nothing but a picture is ever
// served back as one.
function looksLike(bytes, type) {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const text = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  return text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP';
}

async function readPart(form, name, maxBytes) {
  const file = form.get(name);
  if (!file || typeof file === 'string') return { error: 'picture_invalid' };
  const type = file.type.toLowerCase();
  if (!TYPES.has(type) || file.size === 0) return { error: 'picture_invalid' };
  if (file.size > maxBytes) return { error: 'picture_too_big' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  return looksLike(bytes, type) ? { value: bytes, type } : { error: 'picture_invalid' };
}

// Reads a multipart body with `full` and `thumb`, both made by the browser, of one type.
// Only PUT takes it: another site's plain HTML form can send multipart, but only by POST.
export async function readUploadedPicture(request) {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) return { error: 'picture_invalid' };
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_FULL_BYTES + MAX_THUMB_BYTES + 10000) return { error: 'picture_too_big' };
  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: 'picture_invalid' };
  }
  const full = await readPart(form, 'full', MAX_FULL_BYTES);
  if (full.error) return full;
  const thumb = await readPart(form, 'thumb', MAX_THUMB_BYTES);
  if (thumb.error) return thumb;
  if (full.type !== thumb.type) return { error: 'picture_invalid' };
  return { value: { full: full.value, thumb: thumb.value, type: full.type } };
}

const pictureError = (error) => fail(error === 'picture_too_big' ? 413 : 400, error);

// ---- Endpoints ----

// The owner's picture, or anyone's (logged in) when the recipe is public, as Browse shows it.
async function getPicture(request, env, userId, recipeId) {
  const size = new URL(request.url).searchParams.get('size') === 'thumb' ? 'thumb' : 'full';
  const row = await env.DB.prepare(
    `SELECT p.${size} AS bytes, p.type FROM recipe_pictures AS p JOIN recipes AS r ON r.id = p.recipe_id
      WHERE p.recipe_id = ? AND (r.user_id = ? OR r.is_public = 1)`,
  )
    .bind(recipeId, userId)
    .first();
  if (!row) return fail(404, 'not_found');
  return new Response(new Uint8Array(row.bytes), {
    headers: {
      'Content-Type': row.type,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function putPicture(request, env, userId, recipeId) {
  const picture = await readUploadedPicture(request);
  if (picture.error) return pictureError(picture.error);
  const now = Date.now();
  const { meta } = await savePictureStatement(env, { recipeId, userId, picture: picture.value, origin: 'user', now }).run();
  if (!meta.changes) return fail(404, 'not_found');
  return json({ picture: pictureUrls(recipeId, now) });
}

async function deletePicture(env, userId, recipeId) {
  const owned = await env.DB.prepare('SELECT 1 FROM recipes WHERE id = ? AND user_id = ?').bind(recipeId, userId).first();
  if (!owned) return fail(404, 'not_found');
  await env.DB.prepare('DELETE FROM recipe_pictures WHERE recipe_id = ?').bind(recipeId).run();
  return json({ ok: true });
}

// A photo import's picture, sent by the browser right after the import started. While the
// import runs (or failed, for a Retry) it waits in import_pictures, and the save stage
// moves it to the recipe. If the import already finished, it goes to its recipe at once.
// Both are one batch, so a save running at the same moment can't lose it.
async function putImportPicture(request, env, userId, importId) {
  const picture = await readUploadedPicture(request);
  if (picture.error) return pictureError(picture.error);
  const owned = await env.DB.prepare(
    `SELECT 1 FROM llm_requests WHERE id = ? AND user_id = ? AND purpose = 'import' AND platform = 'photo'`,
  )
    .bind(importId, userId)
    .first();
  if (!owned) return fail(404, 'not_found');
  const { full, thumb, type } = picture.value;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO import_pictures (request_id, full, thumb, type)
       SELECT id, ?2, ?3, ?4 FROM llm_requests WHERE id = ?1 AND status IN ('running', 'failed')
       ON CONFLICT (request_id) DO UPDATE SET full = excluded.full, thumb = excluded.thumb, type = excluded.type`,
    ).bind(importId, full, thumb, type),
    env.DB.prepare(
      `INSERT INTO recipe_pictures (recipe_id, full, thumb, type, origin, updated_at)
       SELECT recipe_id, ?2, ?3, ?4, 'photo', ?5 FROM llm_requests
        WHERE id = ?1 AND status = 'done' AND recipe_id IS NOT NULL
       ON CONFLICT (recipe_id) DO NOTHING`,
    ).bind(importId, full, thumb, type, Date.now()),
  ]);
  return json({ ok: true });
}

// Routes /api/recipes/:id/picture and /api/imports/:id/picture. Returns null for any other path.
export function handlePictures(request, env, path, userId) {
  const match = path.match(/^\/api\/(recipes|imports)\/(\d+)\/picture$/);
  if (!match) return null;
  const [, kind, idText] = match;
  const id = Number(idText);
  const method = request.method;
  if (kind === 'imports') return method === 'PUT' ? putImportPicture(request, env, userId, id) : fail(405, 'method_not_allowed');
  if (method === 'GET') return getPicture(request, env, userId, id);
  if (method === 'PUT') return putPicture(request, env, userId, id);
  if (method === 'DELETE') return deletePicture(env, userId, id);
  return fail(405, 'method_not_allowed');
}
