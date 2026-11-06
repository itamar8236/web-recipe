import { beforeEach, describe, expect, it } from 'vitest';
import * as api from './api';
import { pickLanguage } from './i18n';

const content = (name, ingredients = [], steps = []) => ({ name, ingredients, steps });

beforeEach(() => api.resetData());

describe('recipes', () => {
  it('saves a new recipe and trims blank lines', async () => {
    const saved = await api.saveRecipe(null, {
      folderId: 1,
      en: content(' Pancakes ', ['flour', '  ', ' milk '], ['mix', '']),
      he: content(''),
    });
    const loaded = await api.getRecipe(saved.id);
    expect(loaded.en).toEqual(content('Pancakes', ['flour', 'milk'], ['mix']));
    expect(loaded.folderId).toBe(1);
  });

  it('accepts a recipe written only in Hebrew', async () => {
    const saved = await api.saveRecipe(null, { folderId: null, en: content(''), he: content('פנקייק') });
    expect(saved.he.name).toBe('פנקייק');
  });

  it('rejects a recipe with no name in either language', async () => {
    await expect(api.saveRecipe(null, { folderId: null, en: content(''), he: content('  ') })).rejects.toThrow();
  });

  it('updates an existing recipe', async () => {
    await api.saveRecipe(1, { folderId: 2, en: content('Green Shakshuka'), he: content('') });
    const loaded = await api.getRecipe(1);
    expect(loaded.en.name).toBe('Green Shakshuka');
    expect(loaded.folderId).toBe(2);
  });

  it('keeps the source link when a recipe is edited, and manual recipes have none', async () => {
    await api.saveRecipe(2, { folderId: 2, en: content('Lemon Chicken v2'), he: content('') });
    expect((await api.getRecipe(2)).link).toBe('https://claude.ai');
    const manual = await api.saveRecipe(null, { folderId: null, en: content('Toast'), he: content('') });
    expect(manual.link).toBe('');
  });

  it('deletes a recipe', async () => {
    await api.deleteRecipe(1);
    expect(await api.getRecipe(1)).toBeNull();
  });
});

describe('folders', () => {
  it('creates and renames a folder', async () => {
    const folder = await api.createFolder(' Soups ');
    await api.renameFolder(folder.id, 'Hot soups');
    const folders = await api.getFolders();
    expect(folders.find((f) => f.id === folder.id).name).toBe('Hot soups');
  });

  it('rejects an empty folder name', async () => {
    await expect(api.createFolder('   ')).rejects.toThrow();
  });

  it('keeps recipes of a deleted folder, without a folder', async () => {
    await api.deleteFolder(1);
    expect((await api.getFolders()).some((f) => f.id === 1)).toBe(false);
    expect((await api.getRecipe(1)).folderId).toBeNull();
  });
});

describe('pickLanguage', () => {
  it('uses the current language when it has a name', () => {
    const recipe = { en: content('Tea'), he: content('תה') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'תה', translated: true });
  });

  it('falls back to the other language when empty', () => {
    const recipe = { en: content('Tea'), he: content('') };
    expect(pickLanguage(recipe, 'he')).toMatchObject({ name: 'Tea', translated: false });
  });
});
