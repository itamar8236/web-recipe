// Makes the site installable ("Install app" in Chrome on Android).
export const dynamic = 'force-static';

export default function manifest() {
  return {
    name: 'My Recipes',
    short_name: 'Recipes',
    description: 'A simple place to keep recipes in English and Hebrew.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fbf7f1',
    theme_color: '#c4501b',
    // Lists the installed app in Android's Share menu. Shared links open /share, which
    // starts the import. GET, so no service worker code is needed to read the link.
    share_target: {
      action: '/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
