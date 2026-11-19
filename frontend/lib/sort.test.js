import { describe, expect, it } from 'vitest';
import { sortRecipes } from './sort';

const recipes = [
  { id: 1, calories: 300, protein: 10 },
  { id: 2, calories: null, protein: null },
  { id: 3, calories: 800, protein: 40 },
  { id: 4, calories: 120, protein: 10 },
];
const ids = (sort) => sortRecipes(recipes, sort).map((recipe) => recipe.id);

describe('sortRecipes', () => {
  it('sorts by when the recipe was added', () => {
    expect(ids('newest')).toEqual([4, 3, 2, 1]);
    expect(ids('oldest')).toEqual([1, 2, 3, 4]);
  });

  it('puts a recipe with no value last, and keeps ties oldest first', () => {
    expect(ids('protein')).toEqual([3, 1, 4, 2]);
    expect(ids('kcal_high')).toEqual([3, 1, 4, 2]);
    expect(ids('kcal_low')).toEqual([4, 1, 3, 2]);
  });

  it('leaves the list it was given as it was', () => {
    sortRecipes(recipes, 'newest');
    expect(recipes.map((recipe) => recipe.id)).toEqual([1, 2, 3, 4]);
  });
});
