import { describe, expect, it } from 'vitest';
import { isSwipeBack } from './swipe';

describe('isSwipeBack', () => {
  it('goes back on a left-to-right swipe in English', () => {
    expect(isSwipeBack({ dx: 120, dy: 10, ms: 300, dir: 'ltr' })).toBe(true);
    expect(isSwipeBack({ dx: -120, dy: 10, ms: 300, dir: 'ltr' })).toBe(false);
  });

  it('goes back on a right-to-left swipe in Hebrew', () => {
    expect(isSwipeBack({ dx: -120, dy: 10, ms: 300, dir: 'rtl' })).toBe(true);
    expect(isSwipeBack({ dx: 120, dy: 10, ms: 300, dir: 'rtl' })).toBe(false);
  });

  it('ignores a short move', () => {
    expect(isSwipeBack({ dx: 50, dy: 0, ms: 200, dir: 'ltr' })).toBe(false);
  });

  it('ignores a move that is mostly up or down (a scroll)', () => {
    expect(isSwipeBack({ dx: 100, dy: 80, ms: 300, dir: 'ltr' })).toBe(false);
  });

  it('ignores a slow drag', () => {
    expect(isSwipeBack({ dx: 150, dy: 0, ms: 1500, dir: 'ltr' })).toBe(false);
  });
});
