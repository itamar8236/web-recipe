// The orders the recipe lists can be sorted in. The same names go to the Browse API.
// Home starts with 'newest' and Browse with 'random'.
export const SORTS = ['newest', 'oldest', 'protein', 'kcal_high', 'kcal_low'];

// A recipe with no calories or protein comes after every one that has them.
const most = (field) => (a, b) => (b[field] ?? -1) - (a[field] ?? -1);
const COMPARE = {
  newest: (a, b) => b.id - a.id, // ids grow with time
  oldest: (a, b) => a.id - b.id,
  protein: most('protein'),
  kcal_high: most('calories'),
  kcal_low: (a, b) => (a.calories ?? Infinity) - (b.calories ?? Infinity),
};

// A sorted copy of `recipes`; ties keep the oldest first.
export function sortRecipes(recipes, sort) {
  const compare = COMPARE[sort] ?? COMPARE.oldest;
  return [...recipes].sort((a, b) => compare(a, b) || a.id - b.id);
}
