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

