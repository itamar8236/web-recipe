// Which site a pasted link belongs to. The client only ever sends the link, so this is
// the one place that decides. A new platform is one more adapter in SOURCES.

import { youtube } from './youtube.js';

export const SOURCES = [youtube];

const MAX_LINK_LENGTH = 2048;

function parseHttpUrl(text) {
  if (text.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export const detectSource = (url) => SOURCES.find((source) => source.matches(url));

export const sourceFor = (platform) => SOURCES.find((source) => source.platform === platform);

// Reads the pasted text. Returns { source, sourceId, sourceUrl }, or { error } with the
// code to send. Nothing here fetches the link: only its text is looked at.
export function readLink(text) {
  const url = parseHttpUrl(text);
  if (!url) return { error: 'link_invalid' };
  const source = detectSource(url);
  if (!source) return { error: 'link_unsupported' };
  const video = source.parse(url);
  return video ? { source, ...video } : { error: 'link_invalid' };
}
