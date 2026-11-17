import { describe, expect, it } from 'vitest';
import { findSharedLink } from './share';

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
