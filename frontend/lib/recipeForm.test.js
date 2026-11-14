import { describe, expect, it } from 'vitest';
import { toContent, toText, withTranslation } from './recipeForm';

describe('toText / toContent', () => {
  it('turns lines into text and back', () => {
    const content = { name: 'Soup', ingredients: ['2 tomatoes', 'Salt'], steps: ['Boil'] };
    expect(toText(content)).toEqual({ name: 'Soup', ingredients: '2 tomatoes\nSalt', steps: 'Boil' });
    expect(toContent(toText(content))).toEqual(content);
  });
});

describe('withTranslation', () => {
  const form = {
    en: { name: 'Soup (edited)', ingredients: '2 tomatoes', steps: 'Boil' },
    he: { name: 'מרק ישן', ingredients: 'ישן', steps: 'ישן' },
  };
  const translation = { name: 'מרק', ingredients: ['2 עגבניות'], steps: ['להרתיח'] };

  it('keeps the unsaved edits and replaces only the other language', () => {
    expect(withTranslation(form, 'he', translation)).toEqual({
      en: form.en,
      he: { name: 'מרק', ingredients: '2 עגבניות', steps: 'להרתיח' },
    });
  });

  it('does not change the form it was given', () => {
    withTranslation(form, 'he', translation);
    expect(form.he.name).toBe('מרק ישן');
  });
});
