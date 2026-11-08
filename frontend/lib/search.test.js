import { describe, expect, it } from 'vitest';
import { matchesSearch } from './search';

const recipe = {
  en: { name: 'Tomato Soup', ingredients: ['2 tomatoes', 'Fresh basil'], steps: ['Simmer gently'] },
  he: { name: 'מרק עגבניות', ingredients: ['2 עגבניות', 'בזיליקום טרי'], steps: ['לבשל על אש קטנה'] },
};

describe('matchesSearch', () => {
  it('finds a recipe by name, ignoring case', () => {
    expect(matchesSearch(recipe, 'tomato SOUP')).toBe(true);
  });

  it('finds a recipe by part of an ingredient', () => {
    expect(matchesSearch(recipe, 'bas')).toBe(true);
  });

  it('finds a recipe in either language', () => {
    expect(matchesSearch(recipe, 'בזיליקום')).toBe(true);
    expect(matchesSearch(recipe, 'basil')).toBe(true);
  });

  it('needs every word, each anywhere in the name or ingredients', () => {
    expect(matchesSearch(recipe, 'basil soup')).toBe(true);
    expect(matchesSearch(recipe, 'basil chicken')).toBe(false);
  });

  it('does not search the steps', () => {
    expect(matchesSearch(recipe, 'simmer')).toBe(false);
  });

  it('matches everything when nothing is typed', () => {
    expect(matchesSearch(recipe, '')).toBe(true);
    expect(matchesSearch(recipe, '   ')).toBe(true);
  });

  it('handles a recipe written in only one language', () => {
    const englishOnly = { ...recipe, he: { name: '', ingredients: [], steps: [] } };
    expect(matchesSearch(englishOnly, 'soup')).toBe(true);
    expect(matchesSearch(englishOnly, 'מרק')).toBe(false);
  });
});
