// The edit form keeps each language as text (one ingredient / step per line); the api
// stores lines.
export const blankText = { name: '', ingredients: '', steps: '' };

export const toText = (content) => ({
  name: content.name,
  ingredients: content.ingredients.join('\n'),
  steps: content.steps.join('\n'),
});

export const toContent = (text) => ({
  name: text.name,
  ingredients: text.ingredients.split('\n'),
  steps: text.steps.split('\n'),
});

// Calories and protein are typed as text; '' means not known (null). Anything else is sent
// as a number, and the backend says if it isn't a whole number in range.
export const toNumberText = (value) => (value === null || value === undefined ? '' : String(value));
export const toNumber = (text) => (text.trim() === '' ? null : Number(text));

// The form after a translation into `into` arrived: everything the user typed stays as
// it is, and only the other language is replaced, so it can be saved right away.
export const withTranslation = (form, into, content) => ({ ...form, [into]: toText(content) });

// The form after an estimate arrived: only calories and protein are replaced.
export const withNutrition = (form, { calories, protein }) => ({
  ...form,
  calories: toNumberText(calories),
  protein: toNumberText(protein),
});
