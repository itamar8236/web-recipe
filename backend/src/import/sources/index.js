// Which site a pasted link belongs to. The client only ever sends the link, so this is
// the one place that decides. A new platform is one more adapter in SOURCES.

//
// Every adapter has the same shape:
//   platform           the name stored on the import and on the recipe
//   matches(url)       whether the link is on this site
//   parse(url)         { sourceId, sourceUrl }, or null. Looks at the link's text only.
//   fetchPost(sourceId, env)
//                      the post's details: { sourceId, sourceUrl, title, text, transcript,
//                      video }. sourceId and sourceUrl differ from the ones given only for
//                      a share link, which doesn't say which post it is until followed.
//                      `video` is null for a post without one, otherwise { seconds,
//                      isPublic } plus either `uri`, a link the model reads by itself, or
//                      `downloadUrl`, a file that has to be handed to the model.
//   openVideo(video)   only for `downloadUrl`: starts the download, returns the Response.

import { facebook } from './facebook.js';
import { instagram } from './instagram.js';
import { youtube } from './youtube.js';

export const SOURCES = [youtube, facebook, instagram];

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
