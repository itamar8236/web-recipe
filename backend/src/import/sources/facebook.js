// Everything that knows about Facebook links and Facebook's video pages. Only videos and
// reels are read; a photo or text post is not supported yet.

import { ImportError } from '../errors.js';
import { clipText, fetchPage, fetchSubtitles, findObject, jsonBlocks, openVideo, previewText, titleFrom } from './meta.js';

const HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch']);
const VIDEO_ID = /^\d{5,20}$/;
const SHARE_CODE = /^[A-Za-z0-9_-]{4,40}$/;
const SHARE_KINDS = new Set(['v', 'r', 'p']);

const isHost = (hostname) => HOSTS.has(hostname);
const watchUrl = (id) => `https://www.facebook.com/watch/?v=${id}`;

// The video id in a link, or null. Works on the links people paste and on the page a share
// link redirects to.
function videoIdFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  if (parts.length === 2 && parts[0] === 'reel') id = parts[1];
  else if (parts.length === 1 && (parts[0] === 'watch' || parts[0] === 'video.php')) id = url.searchParams.get('v');
  // /<page>/videos/<id> or /<page>/videos/<title>/<id>
  else if ((parts.length === 3 || parts.length === 4) && parts[1] === 'videos') id = parts.at(-1);
  return id && VIDEO_ID.test(id) ? id : null;
}

// A share link (facebook.com/share/r/<code>, fb.watch/<code>) doesn't say which video it
// is: only following it does. Its id is the path it is fetched at, or null.
function sharePathFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const code = parts.at(-1);
  if (!code || !SHARE_CODE.test(code)) return null;
  if (url.hostname === 'fb.watch') return parts.length === 1 ? `fb.watch/${code}` : null;
  if (parts[0] !== 'share') return null;
  if (parts.length === 2) return `share/${code}`;
  return parts.length === 3 && SHARE_KINDS.has(parts[1]) ? `share/${parts[1]}/${code}` : null;
}

const shareUrl = (sharePath) =>
  sharePath.startsWith('fb.watch/') ? `https://${sharePath}/` : `https://www.facebook.com/${sharePath}/`;

// Reads one video out of its page. The page also holds other videos (the "more reels"
// feed), so every part is matched by the video's id.
function readPage(html, id) {
  const quotedId = `"${id}"`;
  const blocks = [
    ...jsonBlocks(html, (block) => block.includes(quotedId) && (block.includes('"videoDeliveryLegacyFields"') || block.includes('"creation_story"'))),
  ];
  const findInBlocks = (matches) => blocks.reduce((found, block) => found ?? findObject(block, matches), null);

  const player = findInBlocks((node) => node.videoDeliveryLegacyFields && (node.id === id || node.videoId === id));
  const story = findInBlocks((node) => node.id === id && node.creation_story?.message);
  const timed = findInBlocks((node) => node.id === id && node.playable_duration_in_ms > 0);
  if (!player && !story) return null;

  const files = player?.videoDeliveryLegacyFields;
  const downloadUrl = files?.browser_native_sd_url ?? files?.browser_native_hd_url ?? null;
  const seconds = player?.length_in_second ?? (timed ? timed.playable_duration_in_ms / 1000 : null);
  return {
    caption: clipText(story?.creation_story.message.text),
    subtitlesUrl: player?.captions_url ?? null,
    video: downloadUrl ? { seconds: seconds > 0 ? seconds : null, isPublic: true, downloadUrl } : null,
  };
}

async function fetchPost(sourceId) {
  const isShare = !VIDEO_ID.test(sourceId);
  const { url, html } = await fetchPage(isShare ? shareUrl(sourceId) : watchUrl(sourceId), isHost);
  const id = isShare ? videoIdFrom(url) : sourceId;
  // A share link can lead to a photo, a profile or anything else.
  if (!id) throw new ImportError('link_unsupported', { detail: `The share link led to ${url.pathname}` });

  const page = readPage(html, id);
  if (!page) {
    if (html.includes('"video":null')) throw new ImportError('video_unavailable', { detail: 'Facebook has no public video with this id' });
    // A page without its data may still carry the caption for link previews.
    const preview = clipText(previewText(html));
    if (!preview) throw new ImportError('source_blocked', { retryable: true, detail: `Facebook sent a page without the video's data (${html.length} bytes)` });
    console.log(`Facebook ${id}: no data blocks in the page, using its preview text`);
    return { sourceId: id, sourceUrl: watchUrl(id), title: titleFrom(preview, 'Facebook'), text: preview, transcript: '', video: null };
  }

  return {
    sourceId: id,
    sourceUrl: watchUrl(id),
    title: titleFrom(page.caption, 'Facebook'),
    text: page.caption,
    transcript: page.subtitlesUrl ? await fetchSubtitles(page.subtitlesUrl) : '',
    video: page.video,
  };
}

export const facebook = {
  platform: 'facebook',
  matches: (url) => isHost(url.hostname),
  // The stored link is rebuilt from the id, so tracking parameters and the rest of the
  // pasted text are dropped. A share link is kept as it is until the import follows it.
  parse(url) {
    const id = videoIdFrom(url);
    if (id) return { sourceId: id, sourceUrl: watchUrl(id) };
    const sharePath = sharePathFrom(url);
    return sharePath ? { sourceId: sharePath, sourceUrl: shareUrl(sharePath) } : null;
  },
  fetchPost,
  openVideo,
};
