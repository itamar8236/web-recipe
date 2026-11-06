'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/components/Language';
import * as api from '@/lib/api';
import styles from '../recipe.module.css';

const blank = { name: '', ingredients: '', steps: '' };

// The form edits text; the api stores one line per ingredient / step.
const toText = (content) => ({
  name: content.name,
  ingredients: content.ingredients.join('\n'),
  steps: content.steps.join('\n'),
});
const toLines = (text) => text.split('\n');
const toContent = (form) => ({
  name: form.name,
  ingredients: toLines(form.ingredients),
  steps: toLines(form.steps),
});

function RecipeForm() {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id') ? Number(params.get('id')) : null;

  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState(params.get('folder') ? Number(params.get('folder')) : null);
  const [form, setForm] = useState({ en: blank, he: blank });
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      setFolders(await api.getFolders());
      if (id !== null) {
        const recipe = await api.getRecipe(id);
        if (recipe) {
          setFolderId(recipe.folderId);
          setForm({ en: toText(recipe.en), he: toText(recipe.he) });
        }
      }
      setReady(true);
    }
    load();
  }, [id]);

  if (!ready) return <p>{t.loading}</p>;

  function update(field, value) {
    setForm({ ...form, [lang]: { ...form[lang], [field]: value } });
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(id, {
        folderId,
        en: toContent(form.en),
        he: toContent(form.he),
      });
      router.push(`/recipe?id=${saved.id}`);
    } catch {
      setError(t.nameRequired);
      setSaving(false);
    }
  }

  // The form edits only the app's current language; the other language is kept as is.
  const current = form[lang];

  return (
    <form className={`${styles.recipe} ${styles.form}`} onSubmit={submit}>
      <div>
        <h1>{id === null ? t.newRecipe : t.editRecipe}</h1>
        <p className={`hint ${styles.subtitle}`}>{t.writingIn}</p>
      </div>

      <div>
        <label className="label" htmlFor="name">{t.recipeName}</label>
        <input id="name" className="field" value={current.name} onChange={(e) => update('name', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="ingredients">
          {t.ingredients} <span className="hint">({t.ingredientsHint})</span>
        </label>
        <textarea id="ingredients" className="field" value={current.ingredients} onChange={(e) => update('ingredients', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="steps">
          {t.instructions} <span className="hint">({t.instructionsHint})</span>
        </label>
        <textarea id="steps" className="field" value={current.steps} onChange={(e) => update('steps', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="folder">{t.folder}</label>
        <select id="folder" className="field" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t.noFolder}</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      <div className={styles.actions}>
        <button type="submit" className="button" disabled={saving}>{t.save}</button>
        <Link href={id === null ? '/' : `/recipe?id=${id}`} className="button secondary">{t.cancel}</Link>
      </div>
    </form>
  );
}

export default function EditRecipePage() {
  return (
    <Suspense fallback={null}>
      <RecipeForm />
    </Suspense>
  );
}
