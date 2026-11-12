// Everything that knows about YouTube links and the YouTube Data API.

import { ImportError } from '../errors.js';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEOS_API = 'https://www.googleapis.com/youtube/v3/videos';

function videoIdFrom(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'youtu.be') return parts.length === 1 ? parts[0] : null;
  if (parts.length === 1 && parts[0] === 'watch') return url.searchParams.get('v');
  if (parts.length === 2 && (parts[0] === 'shorts' || parts[0] === 'live')) return parts[1];
  return null;
}

// An ISO 8601 duration such as PT12M3S, in seconds. null when it can't be read.
function durationSeconds(duration) {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration ?? '');
  if (!match) return null;
  const [weeks, days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return weeks * 604800 + days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

async function fetchMeta(sourceId, env) {
  // Sending nothing without a key: a mistake must never reach Google half-configured.
  if (!env.YOUTUBE_API_KEY) throw new ImportError('llm_error');

  const query = new URLSearchParams({ part: 'snippet,contentDetails,status', id: sourceId, key: env.YOUTUBE_API_KEY });
  let response;
  try {
    response = await fetch(`${VIDEOS_API}?${query}`);
  } catch (error) {
    // The request URL holds the key and an error message might quote it, so only the name is kept.
    throw new ImportError('llm_error', { retryable: true, detail: `YouTube request failed: ${error.name}` });
  }
  if (!response.ok) throw new ImportError('llm_error', { retryable: true, detail: `YouTube ${response.status}` });

  const video = (await response.json()).items?.[0];
  if (!video) throw new ImportError('video_unavailable');
  return {
    title: video.snippet?.title ?? '',
    description: video.snippet?.description ?? '',
    duration: video.contentDetails?.duration ?? '',
    privacyStatus: video.status?.privacyStatus ?? '',
  };
}

export const youtube = {
  platform: 'youtube',
  matches: (url) => HOSTS.has(url.hostname),
  // The stored link is rebuilt from the id, so nothing else in the pasted text is kept.
  parse(url) {
    const id = videoIdFrom(url);
    return id && VIDEO_ID.test(id) ? { sourceId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` } : null;
  },
  fetchMeta,
  durationSeconds,
};
