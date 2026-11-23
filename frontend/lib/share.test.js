import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSharedLink, takeSharedPhotos } from './share';

describe('findSharedLink', () => {
  it('finds the link that Android puts in the text', () => {
    expect(findSharedLink({ text: 'https://youtu.be/abc123?si=xyz' })).toBe('https://youtu.be/abc123?si=xyz');
  });

  it('finds a link among other words', () => {
    expect(findSharedLink({ title: 'Pasta', text: 'Look at this reel! https://www.instagram.com/reel/C1/?igsh=a1 so good' }))
      .toBe('https://www.instagram.com/reel/C1/?igsh=a1');
  });

  it('prefers the url field, then text, then title', () => {
    expect(findSharedLink({ url: 'https://a.com/1', text: 'https://b.com/2' })).toBe('https://a.com/1');
    expect(findSharedLink({ title: 'https://c.com/3', text: 'no link' })).toBe('https://c.com/3');
  });

  it('drops punctuation that ends the sentence', () => {
    expect(findSharedLink({ text: 'Try this (https://www.facebook.com/share/r/1Ab2/).' }))
      .toBe('https://www.facebook.com/share/r/1Ab2/');
  });

  it('returns an empty string when nothing was shared', () => {
    expect(findSharedLink({})).toBe('');
    expect(findSharedLink({ text: 'just words' })).toBe('');
  });
});

// A tiny stand-in for the browser's Cache API, holding what public/sw.js puts there.
function fakeCaches(entries) {
  const stored = new Map(entries.map(([path, response]) => [`https://app.test${path}`, response]));
  return {
    open: async () => ({
      keys: async () => [...stored.keys()].map((url) => new Request(url)),
      match: async (request) => stored.get(request.url),
    }),
    delete: async () => stored.clear() ?? true,
    stored,
  };
}

describe('takeSharedPhotos', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the shared photos in order, with their names and types, and deletes them', async () => {
    const photo = (bytes, type, name) =>
      new Response(new Blob([bytes], { type }), { headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });
    const fake = fakeCaches([
      ['/shared-photo/10', photo('c', 'image/png', 'c.png')],
      ['/shared-photo/2', photo('b', 'image/jpeg', 'מתכון.jpg')],
      ['/shared-photo/0', photo('a', 'image/jpeg', 'a.jpg')],
    ]);
    vi.stubGlobal('caches', fake);
    const photos = await takeSharedPhotos();
    expect(photos.map((file) => file.name)).toEqual(['a.jpg', 'מתכון.jpg', 'c.png']);
    expect(photos.map((file) => file.type)).toEqual(['image/jpeg', 'image/jpeg', 'image/png']);
    expect(await photos[0].text()).toBe('a');
    expect(fake.stored.size).toBe(0);
  });

  it('returns no photos when none were shared', async () => {
    vi.stubGlobal('caches', fakeCaches([]));
    expect(await takeSharedPhotos()).toEqual([]);
  });
});
