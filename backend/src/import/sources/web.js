// Any other web page, such as a recipe site's article. It is the last adapter: a link on
// YouTube, Facebook or Instagram never gets here. Unlike the other adapters, the page has
// no id to rebuild a link from, so the pasted link itself is fetched, which is why every
// hop is checked by `isFetchableUrl` (backend/IMPORT.md → Web pages). Everything that
// comes back is untrusted data, read as text only; nothing on the page is followed, except
// its one preview image (og:image), which the picture step fetches with the same checks. A page
// that turns the Worker away is left for the model to open with Google's URL tool.

import { ImportError } from '../errors.js';
import { previewImageUrl } from '../../pictures.js';
import { BROWSER_HEADERS, decodeEntities } from './meta.js';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30 * 1000;
// Recipe pages are a few hundred kilobytes; a bigger answer isn't a page worth reading.
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
// Enough for a long recipe with its story, and still a small part of a model's context.
const MAX_TEXT_LENGTH = 20000;
const MAX_TITLE_LENGTH = 120;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|wp-login\.php)(\/|$)/i;
// Names that only make sense inside a private network, never on the public web.
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|test|invalid|example)$/i;
const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|dclid|msclkid|igsh|igshid|mc_cid|mc_eid)$/i;
// How a site's bot protection turns the Worker away: such sites often block Cloudflare's
// addresses, not Google's, so the model is asked to open the page itself.
const BLOCKED_STATUSES = [403, 429];

const blocked = (detail, retryable = false) => new ImportError('source_blocked', { retryable, detail });

// Whether the Worker may fetch this URL: a public web address on the default port, named
// by a real domain. IP addresses (the URL parser turns every numeric form into one),
// single-label names and private-network names are refused, as are links with a login.
export function isFetchableUrl(url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password || url.port) return false;
  const host = url.hostname;
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  if (!host.includes('.') || PRIVATE_SUFFIX.test(host)) return false;
  // The last label must be a real top-level domain's shape (letters, or punycode).
  return /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host.split('.').pop());
}

// The link to store: the same page for every form of it, so a shared copy with tracking
// parameters is the same import as the plain one.
function normalized(url) {
  const clean = new URL(url);
  clean.hash = '';
  for (const key of [...clean.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) clean.searchParams.delete(key);
  }
  return clean.href;
}

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new ImportError('link_unsupported', { detail: `The page is over ${MAX_PAGE_BYTES} bytes` });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function get(url) {
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw blocked(`${url.hostname} request failed: ${error.name}`, true);
  }
}

// Gets the page, following redirects by hand so that every hop passes the same check as
// the pasted link. Sites redirect to their own www host or to https, but any public host is
// allowed, since a page may have moved.
async function fetchWebPage(startUrl) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(url)) throw new ImportError('link_unsupported', { detail: `Redirected to ${url.protocol}//${url.host}` });
    if (hop > 0 && LOGIN_PATH.test(url.pathname)) throw new ImportError('login_required', { detail: `Redirected to ${url.hostname}${url.pathname}` });

    const response = await get(url);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (BLOCKED_STATUSES.includes(response.status)) {
      await response.body?.cancel();
      console.log(`${url.hostname} answered ${response.status}: the model will open the page itself`);
      return { url, blocked: true };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) throw new ImportError('video_unavailable', { detail: `${url.hostname} answered ${response.status}` });
      if (response.status === 401) throw new ImportError('login_required', { detail: `${url.hostname} answered 401` });
      // A 5xx may pass.
      throw blocked(`${url.hostname} answered ${response.status}`, response.status >= 500);
    }
    const type = (response.headers.get('content-type') ?? 'text/html').split(';')[0].trim().toLowerCase();
    if (!PAGE_TYPES.includes(type)) {
      await response.body?.cancel();
      throw new ImportError('link_unsupported', { detail: `The link is a ${type} file, not a page` });
    }
    return { url, html: await readCapped(response), isHtml: type !== 'text/plain' };
  }
  throw blocked('Too many redirects');
}

const plain = (text) =>
  decodeEntities(String(text ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

// The page's text as a reader sees it, one block per line. Scripts, styles, menus and
// footers hold no recipe and would only crowd it out of the text limit.
export function pageText(html) {
  const bodyStart = html.search(/<body[\s>]/i);
  const text = (bodyStart === -1 ? html : html.slice(bodyStart))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|select|button)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|main|blockquote|figure|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const lines = [];
  for (const line of decodeEntities(text).split('\n')) {
    const clean = line.replace(/[\s‎‏]+/g, ' ').trim();
    if (clean && clean !== lines[lines.length - 1]) lines.push(clean);
  }
  return lines.join('\n');
}

const isRecipe = (node) => {
  const type = node?.['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
};

function findRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && isRecipe(node)) return node;
  for (const value of Object.values(node)) {
    const found = findRecipe(value);
    if (found) return found;
  }
  return null;
}

// Instructions in schema.org come as a string, a list of strings, steps ({text}) or
// sections ({name, itemListElement}); all of them become plain lines.
function instructionLines(value) {
  if (!value) return [];
  if (typeof value === 'string') return [plain(value)];
  if (Array.isArray(value)) return value.flatMap(instructionLines);
  if (typeof value !== 'object') return [];
  if (value.itemListElement) return [plain(value.name), ...instructionLines(value.itemListElement)];
  return [plain(value.text ?? value.name)];
}

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// Who the schema.org recipe says it is by: a name, a Person or Organization, or a list of
// them (the first counts). A reference to a node elsewhere on the page ({"@id"}) has no
// name here, so the model looks for one in the text instead.
function authorName(value) {
  const [first] = list(value);
  return plain(typeof first === 'string' ? first : first?.name) || null;
}

// Many recipe sites describe the recipe for search engines in a schema.org block, the
// cleanest text there is. Only a block with both ingredients and steps is used. Returns
// { text, author } or null.
export function structuredRecipe(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, block] of blocks) {
    let recipe;
    try {
      recipe = findRecipe(JSON.parse(block));
    } catch {
      continue;
    }
    if (!recipe) continue;
    const ingredients = list(recipe.recipeIngredient ?? recipe.ingredients).map(plain).filter(Boolean);
    const steps = instructionLines(recipe.recipeInstructions).filter(Boolean);
    if (!ingredients.length || !steps.length) return null;
    const nutrition = recipe.nutrition ?? {};
    const text = [
      plain(recipe.name),
      plain(recipe.description),
      list(recipe.recipeYield).length ? `Makes: ${list(recipe.recipeYield).map(plain).join(', ')}` : '',
      nutrition.calories ? `Calories: ${plain(nutrition.calories)}` : '',
      nutrition.proteinContent ? `Protein: ${plain(nutrition.proteinContent)}` : '',
      'Ingredients:',
      ...ingredients,
      'Instructions:',
      ...steps,
    ]
      .filter(Boolean)
      .join('\n');
    return { text, author: authorName(recipe.author) };
  }
  return null;
}

function pageTitle(html, url) {
  const head = html.slice(0, 300000);
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(head)?.[1];
  const title = og ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return plain(title).slice(0, MAX_TITLE_LENGTH) || url.hostname;
}

async function fetchPost(sourceId) {
  const { url, html, isHtml, blocked: isBlocked } = await fetchWebPage(sourceId);
  // Nothing of the page is had, so the model gets its address (the last hop, which passed
  // isFetchableUrl) and opens it with Google's URL tool (stages.js).
  if (isBlocked) return { sourceId, sourceUrl: sourceId, title: url.hostname, text: '', transcript: '', video: null, pageUrl: url.href };
  // The structured block comes first because it is the cleanest, but the page goes too:
  // sites often leave a part out of it, such as a topping's ingredients.
  const structured = isHtml ? structuredRecipe(html) : null;
  const body = isHtml ? pageText(html) : html;
  const text = structured ? `${structured.text}\n\nThe whole page:\n${body}` : body;
  return {
    sourceId,
    sourceUrl: sourceId,
    title: isHtml ? pageTitle(html, url) : url.hostname,
    text: text.trim().slice(0, MAX_TEXT_LENGTH),
    transcript: '',
    video: null,
    author: structured?.author ?? null,
    pictureUrls: [isHtml ? previewImageUrl(html, url) : null].filter(Boolean),
  };
}

export const web = {
  platform: 'web',
  matches: isFetchableUrl,
  parse: (url) => {
    const link = normalized(url);
    return { sourceId: link, sourceUrl: link };
  },
  fetchPost,
};
