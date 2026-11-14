// Everything that knows about Instagram links and Instagram's post pages: reels and
// videos, and photo or carousel posts, which have only their caption to read.

import { ImportError } from '../errors.js';
import { clipText, fetchPage, findObject, jsonBlocks, openVideo, previewText, titleFrom } from './meta.js';

const HOSTS = new Set(['instagram.com', 'www.instagram.com', 'instagr.am']);
const CODE = /^[A-Za-z0-9_-]{5,40}$/;
const POST_KINDS = new Set(['p', 'reel', 'reels', 'tv']);
const SHARE_KINDS = new Set(['p', 'reel']);

const isHost = (hostname) => HOSTS.has(hostname);
const postUrl = (code) => `https://www.instagram.com/p/${code}/`;

// The post's code in a link, or null: /reel/<code>, /p/<code>, /tv/<code>, with or without
// the username first. Every kind of post also opens at /p/<code>.
function codeFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'share') return null;
  const kindAt = POST_KINDS.has(parts[0]) ? 0 : 1;
  if (parts.length !== kindAt + 2 || !POST_KINDS.has(parts[kindAt])) return null;
  return CODE.test(parts[kindAt + 1]) ? parts[kindAt + 1] : null;
}

// A share link (instagram.com/share/reel/<code>) has its own code, which only says which
// post it is once followed. Its id is the path it is fetched at, or null.
function sharePathFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const code = parts.at(-1);
  if (parts[0] !== 'share' || !code || !CODE.test(code)) return null;
  if (parts.length === 2) return `share/${code}`;
  return parts.length === 3 && SHARE_KINDS.has(parts[1]) ? `share/${parts[1]}/${code}` : null;
}

const shareUrl = (sharePath) => `https://www.instagram.com/${sharePath}/`;

// The video's length is only written in its streaming manifest, as PT1M5.3S.
function secondsFrom(manifest) {
  const match = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/.exec(manifest ?? '');
  if (!match) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

function readPage(html, code) {
  const [block] = jsonBlocks(html, (text) => text.includes('"xig_polaris_media"'));
  const post = findObject(block, (node) => node.xig_polaris_media !== undefined)?.xig_polaris_media;
  if (!post) return null;
  // The post exists but Instagram shows it only to logged-in people (e.g. an age limit).
  const media = post.if_not_gated_logged_out;
  if (!media) throw new ImportError('login_required', { detail: 'Instagram shows this post only after a login' });
  if (media.code !== code) throw new ImportError('source_blocked', { retryable: true, detail: 'Instagram sent a different post than the one asked for' });

  const downloadUrl = media.video_versions?.[0]?.url ?? null;
  return {
    caption: clipText(media.caption?.text),
    video: downloadUrl ? { seconds: secondsFrom(media.video_dash_manifest), isPublic: true, downloadUrl } : null,
  };
}

async function fetchPost(sourceId) {
  const isShare = sourceId.startsWith('share/');
  const { url, html } = await fetchPage(isShare ? shareUrl(sourceId) : postUrl(sourceId), isHost);
  const code = isShare ? codeFrom(url) : sourceId;
  // A share link can lead to a profile, a story or anything else.
  if (!code) throw new ImportError('link_unsupported', { detail: `The share link led to ${url.pathname}` });

  const page = readPage(html, code);
  if (!page) {
    if (html.includes('"pageID":"httpErrorPage"')) throw new ImportError('video_unavailable', { detail: 'Instagram has no public post with this code' });
    if (html.includes('"pageID":"loginPage"')) throw new ImportError('login_required', { detail: 'Instagram answered with its login page' });
    // A page without its data may still carry the caption for link previews.
    const preview = clipText(previewText(html));
    if (!preview) throw new ImportError('source_blocked', { retryable: true, detail: `Instagram sent a page without the post's data (${html.length} bytes)` });
    console.log(`Instagram ${code}: no data block in the page, using its preview text`);
    return { sourceId: code, sourceUrl: postUrl(code), title: titleFrom(preview, 'Instagram'), text: preview, transcript: '', video: null };
  }

  return {
    sourceId: code,
    sourceUrl: postUrl(code),
    title: titleFrom(page.caption, 'Instagram'),
    text: page.caption,
    transcript: '',
    video: page.video,
  };
}

export const instagram = {
  platform: 'instagram',
  matches: (url) => isHost(url.hostname),
  // The stored link is rebuilt from the code, so tracking parameters and the rest of the
  // pasted text are dropped. A share link is kept as it is until the import follows it.
  parse(url) {
    const code = codeFrom(url);
    if (code) return { sourceId: code, sourceUrl: postUrl(code) };
    const sharePath = sharePathFrom(url);
    return sharePath ? { sourceId: sharePath, sourceUrl: shareUrl(sharePath) } : null;
  },
  fetchPost,
  openVideo,
};
