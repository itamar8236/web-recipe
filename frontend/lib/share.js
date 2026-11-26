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

// The link that shares a public recipe: it opens Browse with the recipe's name already in
// the search, so the recipe shows up for whoever opens it. Browse lists only public recipes,
// so there is no link for a private one.
export function recipeShareLink(origin, name) {
  return `${origin}/browse?q=${encodeURIComponent(name)}`;
}

// A recipe as plain text, for someone who doesn't use the app: the name, the ingredients,
// the steps, and who it is by and where it came from when known. `labels` are the headings
// in the language of the text itself, which may not be the app's.
export function recipeText(content, labels, { author, link } = {}) {
  const parts = [
    content.name,
    [`${labels.ingredients}:`, ...content.ingredients.map((item) => `• ${item}`)].join('\n'),
    [`${labels.instructions}:`, ...content.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n'),
  ];
  const credits = [author && `${labels.author}: ${author}`, link && `${labels.sourceLink}: ${link}`].filter(Boolean);
  if (credits.length) parts.push(credits.join('\n'));
  return parts.join('\n\n');
}

// Shares a link (`url`) or, with no url, the `text` itself. A phone gets its share sheet
// (WhatsApp, messages...); a computer gets it copied, since a desktop's share dialog is
// rarely where people send things from. Returns 'shared', 'cancelled' (the user closed the
// sheet) or 'copied'; throws when copying failed.
export async function shareLink({ title, text, url }, nav = navigator, touch = matchMedia('(pointer: coarse)').matches) {
  if (touch && nav.share) {
    try {
      await nav.share(url ? { title, text, url } : { title, text });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // Some in-app browsers refuse to share: copying still works there.
    }
  }
  await nav.clipboard.writeText(url ?? text);
  return 'copied';
}
