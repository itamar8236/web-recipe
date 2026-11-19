import { describe, expect, it } from 'vitest';
import { toContent, toNumber, toNumberText, toText } from './recipeForm';

describe('toText / toContent', () => {
  it('turns lines into text and back', () => {
    const content = { name: 'Soup', ingredients: ['2 tomatoes', 'Salt'], steps: ['Boil'] };
    expect(toText(content)).toEqual({ name: 'Soup', ingredients: '2 tomatoes\nSalt', steps: 'Boil' });
    expect(toContent(toText(content))).toEqual(content);
  });
});

describe('toNumberText / toNumber', () => {
  it('shows a missing number as an empty field, and an empty field as null', () => {
    expect(toNumberText(null)).toBe('');
    expect(toNumberText(450)).toBe('450');
    expect(toNumber(' ')).toBeNull();
    expect(toNumber('450')).toBe(450);
  });
});
