// A model sometimes slips another language into a recipe (Russian or Chinese words inside
// Hebrew text, say). Only letters count: digits, fractions, symbols and emoji are fine, and
// accented Latin letters (sautéed, jalapeño) belong to English text.
const FOREIGN_LETTER = /(?![\p{Script=Latin}\p{Script=Hebrew}])\p{L}/u;

// True when the recipe text of one language (name, ingredients, steps) has such a letter.
export function hasForeignScript(content) {
  const text = [content.name, ...(content.ingredients || []), ...(content.steps || [])].join('\n');
  return FOREIGN_LETTER.test(text);
}
