import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSharedLink, recipeShareLink, shareLink, takeSharedPhotos } from './share';

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

describe('recipeShareLink', () => {
  it('opens Browse with the name in the search', () => {
    expect(recipeShareLink('https://app.example', 'Pasta & beans')).toBe('https://app.example/browse?q=Pasta%20%26%20beans');
  });

  it('keeps a Hebrew name readable after decoding', () => {
    const link = new URL(recipeShareLink('https://app.example', 'עוגת שוקולד'));
    expect(link.searchParams.get('q')).toBe('עוגת שוקולד');
  });
});

describe('shareLink', () => {
  const item = { title: 'Pasta', text: 'A recipe for you: Pasta', url: 'https://app.example/browse?q=Pasta' };
  const clipboard = () => ({ writeText: vi.fn().mockResolvedValue() });

  it('opens the share sheet on a phone', async () => {
    const nav = { share: vi.fn().mockResolvedValue(), clipboard: clipboard() };
    expect(await shareLink(item, nav, true)).toBe('shared');
    expect(nav.share).toHaveBeenCalledWith(item);
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('does nothing more when the user closes the sheet', async () => {
    const nav = { share: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' })), clipboard: clipboard() };
    expect(await shareLink(item, nav, true)).toBe('cancelled');
    expect(nav.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copies the link when sharing is refused', async () => {
    const nav = { share: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' })), clipboard: clipboard() };
    expect(await shareLink(item, nav, true)).toBe('copied');
    expect(nav.clipboard.writeText).toHaveBeenCalledWith(item.url);
  });

  it('copies the link on a computer, even with a share dialog', async () => {
    const nav = { share: vi.fn(), clipboard: clipboard() };
    expect(await shareLink(item, nav, false)).toBe('copied');
    expect(nav.share).not.toHaveBeenCalled();
  });

  it('throws when the link cannot be copied', async () => {
    await expect(shareLink(item, {}, false)).rejects.toThrow();
  });
});
