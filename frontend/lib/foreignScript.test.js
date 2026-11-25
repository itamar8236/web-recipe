import { describe, expect, it } from 'vitest';
import { hasForeignScript } from './foreignScript';

const recipe = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

describe('hasForeignScript', () => {
  it('accepts English, Hebrew, accents, numbers and symbols', () => {
    expect(hasForeignScript(recipe('Jalapeño crème brûlée', ['½ cup sugar', '200°C'], ['Mix 🙂']))).toBe(false);
    expect(hasForeignScript(recipe('שקשוקה', ['2 ביצים', 'Tabasco'], ['מערבבים היטב.']))).toBe(false);
  });

  it('finds another script in the name, an ingredient or a step', () => {
    expect(hasForeignScript(recipe('עוגת שוקולад'))).toBe(true);
    expect(hasForeignScript(recipe('Pancakes', ['2 eggs', '面粉 1 cup']))).toBe(true);
    expect(hasForeignScript(recipe('חומוס', [], ['מוסיפים طحينة']))).toBe(true);
  });

  it('handles an empty language', () => {
    expect(hasForeignScript(recipe('', [], []))).toBe(false);
  });
});
