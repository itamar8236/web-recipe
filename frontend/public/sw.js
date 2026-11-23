// Minimal service worker so the app is installable. It caches no pages or data: recipes
// are always fetched live, so users never see stale data. Its one job is Android's Share
// menu (`share_target` in app/manifest.js), which POSTs what was shared to /share.

// Shared photos wait here until the /share page takes them (lib/share.js, same name).
const SHARED_PHOTOS_CACHE = 'shared-photos';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share') {
    event.respondWith(receiveShare(event.request));
  }
});

// A static page can't read a POST, so the shared photos are kept in a cache and the page
// opens with their number, or a shared link opens the page with it in the query, as before.
async function receiveShare(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect('/share', 303);
  }
  const photos = form.getAll('photos').filter((value) => value instanceof File);
  if (photos.length) {
    await caches.delete(SHARED_PHOTOS_CACHE);
    const cache = await caches.open(SHARED_PHOTOS_CACHE);
    await Promise.all(
      photos.map((photo, index) =>
        cache.put(
          `/shared-photo/${index}`,
          new Response(photo, { headers: { 'Content-Type': photo.type, 'X-File-Name': encodeURIComponent(photo.name) } }),
        ),
      ),
    );
    return Response.redirect(`/share?photos=${photos.length}`, 303);
  }
  const query = new URLSearchParams();
  for (const name of ['title', 'text', 'url']) {
    const value = form.get(name);
    if (typeof value === 'string' && value) query.set(name, value);
  }
  return Response.redirect(`/share?${query}`, 303);
}
