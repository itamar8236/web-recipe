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
    // Lists the installed app in Android's Share menu for links and photos. POST, since
    // only a POST can carry files; public/sw.js receives it and opens /share, which
    // starts the import.
    share_target: {
      action: '/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [{ name: 'photos', accept: ['image/*', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'] }],
      },
    },
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
