// Android's Share menu puts the link in `text` (its share system has no url field), often
// with words around it ("Check out this reel! https://..."), and sometimes in `title` or
// `url`. Returns the first http(s) link found, or '' when there is none. The backend checks
// the link itself; this only picks it out of the shared text.
export function findSharedLink({ title, text, url }) {
  for (const value of [url, text, title]) {
    const match = /https?:\/\/[^\s<>"]+/i.exec(value ?? '');
    if (match) return match[0].replace(/[.,!?)\]]+$/, '');
  }
  return '';
}

// Where public/sw.js keeps photos shared from the phone's gallery (the same name there).
const SHARED_PHOTOS_CACHE = 'shared-photos';

// Returns the photos public/sw.js kept, as Files in the order they were shared, and
// deletes them, so they're imported once. [] when there are none (or no cache API).
export async function takeSharedPhotos() {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(SHARED_PHOTOS_CACHE);
  const requests = await cache.keys();
  const position = (request) => Number(new URL(request.url).pathname.split('/').pop());
  requests.sort((a, b) => position(a) - position(b));
  const photos = [];
  for (const request of requests) {
    const response = await cache.match(request);
    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get('X-File-Name') || 'photo');
    photos.push(new File([blob], name, { type: blob.type }));
  }
  await caches.delete(SHARED_PHOTOS_CACHE);
  return photos;
}
