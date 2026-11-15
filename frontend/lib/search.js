// A recipe matches when every typed word appears in its name, its ingredients or one of
// its tag names. Both languages are searched, so a recipe is found whichever language the
// app is showing.
export function matchesSearch(recipe, query, tagNames = []) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [recipe.en, recipe.he]
    .flatMap((content) => [content.name, ...content.ingredients])
    .concat(tagNames)
    .join('\n')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}
