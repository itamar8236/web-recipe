// What the Facebook and Instagram adapters share. Both sites belong to Meta and are read
// the way an anonymous visitor's browser reads a public post: no account, cookies or
// tokens. Everything that comes back is untrusted data.

import { ImportError } from '../errors.js';

// The headers a browser sends when someone opens a link. Facebook answers 400 to a request
// without them.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const LOGIN_PATH = /^\/(login(\.php)?|accounts\/login|checkpoint)(\/|$)/;
// Video and subtitle files live on Meta's CDN, on hosts that change from post to post.
const CDN_HOST = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/;
const MAX_TEXT_LENGTH = 20000;
const MAX_TITLE_LENGTH = 120;

const blocked = (detail, retryable = false) => new ImportError('source_blocked', { retryable, detail });

async function get(url) {
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw blocked(`${url.hostname} request failed: ${error.name}`, true);
  }
}

// Gets a page, following redirects by hand so that every hop is checked: it must stay on
// the site's own hosts (`isSiteHost`), and a hop to a login page means the post isn't
// public. Returns the page and the URL it ended on, which for a share link is the first
// place that says which post it is.
export async function fetchPage(startUrl, isSiteHost) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || !isSiteHost(url.hostname)) throw blocked(`Redirected off the site, to ${url.hostname}`);
    if (LOGIN_PATH.test(url.pathname)) throw new ImportError('login_required', { detail: `Redirected to ${url.hostname}${url.pathname}` });

    const response = await get(url);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404 || response.status === 410) throw new ImportError('video_unavailable');
    // 403 and 429 are how a block or a rate limit looks; it may pass, so the stage is retried.
    if (!response.ok) throw blocked(`${url.hostname} answered ${response.status}`, true);
    return { url, html: await response.text() };
  }
  throw blocked('Too many redirects');
}

// The pages keep their data in <script type="application/json"> blocks, one JSON document
// each. Yields the parsed blocks that `isWanted` picks by their raw text: a page is a
// megabyte or two with dozens of blocks, and a Workflow step has very little CPU time, so
// only the one or two that matter are parsed.
export function* jsonBlocks(html, isWanted) {
  const open = '<script type="application/json"';
  for (let at = html.indexOf(open); at !== -1; at = html.indexOf(open, at)) {
    const start = html.indexOf('>', at) + 1;
    const end = html.indexOf('</script>', start);
    if (start === 0 || end === -1) return;
    at = end;
    const block = html.slice(start, end);
    if (!isWanted(block)) continue;
    try {
      yield JSON.parse(block);
    } catch {
      // A block that isn't JSON after all holds nothing for us.
    }
  }
}

// The first object anywhere inside `node` that `matches`, or null. The data's place in the
// page moves between layouts, so it is found by what it holds, not by a fixed path.
export function findObject(node, matches) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node) && matches(node)) return node;
  for (const value of Object.values(node)) {
    const found = findObject(value, matches);
    if (found) return found;
  }
  return null;
}

function decodeEntities(text) {
  const named = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (entity, hex, decimal, name) => {
    if (name) return named[name.toLowerCase()] ?? entity;
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// The text link previews show (og:title, og:description), for a page that came without
// its data blocks: the caption is usually still there, cut short and wrapped in view counts.
export function previewText(html) {
  const head = html.slice(0, 300000);
  const texts = ['og:title', 'og:description'].map((property) => {
    const tag = new RegExp(`<meta[^>]+property="${property}"[^>]*content="([^"]*)"`).exec(head);
    return tag ? decodeEntities(tag[1]).trim() : '';
  });
  return texts.sort((a, b) => b.length - a.length)[0];
}

export const clipText = (text) => String(text ?? '').trim().slice(0, MAX_TEXT_LENGTH);

// A post has no title of its own, so its card shows where the caption starts.
export function titleFrom(caption, fallback) {
  // Captions often start with invisible text-direction marks, which would show as a gap.
  const lines = caption.replace(/[‎‏‪-‮⁦-⁩]/g, '').split('\n');
  const firstLine = lines.find((line) => line.trim()) ?? '';
  return firstLine.trim().slice(0, MAX_TITLE_LENGTH) || fallback;
}

function cdnUrl(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && CDN_HOST.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

// A subtitle file (.srt) as plain text: the numbering and the times are dropped. Subtitles
// are an extra, so anything that goes wrong just means there are none.
export async function fetchSubtitles(link) {
  const url = cdnUrl(link);
  if (!url) return '';
  try {
    const response = await get(url);
    if (!response.ok) return '';
    const lines = (await response.text()).split(/\r?\n/).filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->'));
    return clipText(lines.join(' '));
  } catch {
    return '';
  }
}

// Starts downloading a post's video and returns the response, for its body to be streamed
// on. The link came out of the page, so it is only followed onto Meta's CDN.
export async function openVideo(video) {
  const url = cdnUrl(video.downloadUrl);
  if (!url) throw new ImportError('video_unavailable', { detail: 'The video is on an unexpected host' });
  let response;
  try {
    // A plain request, as a video player makes: the CDN redirects one that says it is
    // opening a page. No timeout: it would also cut the download short, and the step has
    // its own.
    response = await fetch(url, { redirect: 'manual' });
  } catch (error) {
    throw new ImportError('video_unavailable', { retryable: true, detail: `Video download failed: ${error.name}` });
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new ImportError('video_unavailable', { retryable: response.status >= 500, detail: `${url.hostname} answered ${response.status} for the video` });
  }
  return response;
}
