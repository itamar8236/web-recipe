'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/components/Language';
import { LANGUAGES, languageLabels } from '@/lib/i18n';
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
  const [chosenTab, setTab] = useState(null);
  // Until a tab is picked, edit the language the UI is currently in.
  const tab = chosenTab ?? lang;
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
    setForm({ ...form, [tab]: { ...form[tab], [field]: value } });
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

  const current = form[tab];
  const dir = tab === 'he' ? 'rtl' : 'ltr';

  return (
    <form className={`${styles.recipe} ${styles.form}`} onSubmit={submit}>
      <h1>{id === null ? t.newRecipe : t.editRecipe}</h1>

      <div className={styles.tabs} role="group" aria-label={t.language}>
        {LANGUAGES.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            className={code === tab ? styles.active : ''}
            aria-pressed={code === tab}
            onClick={() => setTab(code)}
          >
            {languageLabels[code]}
          </button>
        ))}
      </div>

      <div>
        <label className="label" htmlFor="name">{t.recipeName}</label>
        <input id="name" className="field" lang={tab} dir={dir} value={current.name} onChange={(e) => update('name', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="ingredients">
          {t.ingredients} <span className="hint">({t.ingredientsHint})</span>
        </label>
        <textarea id="ingredients" className="field" lang={tab} dir={dir} value={current.ingredients} onChange={(e) => update('ingredients', e.target.value)} />
      </div>

      <div>
        <label className="label" htmlFor="steps">
          {t.instructions} <span className="hint">({t.instructionsHint})</span>
        </label>
        <textarea id="steps" className="field" lang={tab} dir={dir} value={current.steps} onChange={(e) => update('steps', e.target.value)} />
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
