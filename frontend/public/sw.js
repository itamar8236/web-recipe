// Minimal service worker so the app is installable. It caches nothing: recipes are
// always fetched live, so users never see stale data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
