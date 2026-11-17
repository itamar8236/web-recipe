'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import RecipeAiTools from '@/components/RecipeAiTools';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import { blankText, toContent, toNumber, toNumberText, toText, withNutrition, withTranslation } from '@/lib/recipeForm';
import styles from '../recipe.module.css';

function RecipeForm() {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id') ? Number(params.get('id')) : null;

  const [form, setForm] = useState({ en: blankText, he: blankText, calories: '', protein: '' });
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'missing' | 'error'
  const [attempt, setAttempt] = useState(0); // bumped by "Try again"
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  // Translating and scanning need an account, like importing. So does public or private:
  // a guest's recipes are never sent anywhere.
  const auth = useAuth();
  const loggedIn = auth.status === 'user';
  // Saved with the form, so Cancel leaves it as it was. A new recipe starts with the default.
  const [isPublic, setIsPublic] = useState(auth.user?.defaultPublic ?? true);
  // A translation or an estimate saves when it arrives, so it needs what the user has typed by then,
  // not what the form held when they tapped the button.
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  }, [form]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const recipe = id === null ? null : await api.getRecipe(id);
        if (cancelled) return;
        if (id !== null && !recipe) return setStatus('missing');
        if (recipe) {
          setLink(recipe.link);
          setIsPublic(recipe.public);
          setForm({
            en: toText(recipe.en),
            he: toText(recipe.he),
            calories: toNumberText(recipe.calories),
            protein: toNumberText(recipe.protein),
          });
        }
        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(t, err));
          setStatus('error');
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // `t` is left out on purpose: switching language must not reload and wipe the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, attempt]);

  if (status === 'loading') return <p>{t.loading}</p>;
  if (status === 'missing') {
    return (
      <>
        <p>{t.notFound}</p>
        <Link href="/" className="button secondary">{t.back}</Link>
      </>
    );
  }
  if (status === 'error') {
    return (
      <div role="alert">
        <p className="error">{error}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className="button"
            onClick={() => {
              setError('');
              setStatus('loading');
              setAttempt(attempt + 1);
            }}
          >
            {t.retry}
          </button>
          <Link href="/" className="button secondary">{t.back}</Link>
        </div>
      </div>
    );
  }

  function update(field, value) {
    setForm({ ...form, [lang]: { ...form[lang], [field]: value } });
  }

  // Saves and opens the recipe view; on failure stays here with the form as it is.
  async function save(values) {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveRecipe(id, {
        en: toContent(values.en),
        he: toContent(values.he),
        calories: toNumber(values.calories),
        protein: toNumber(values.protein),
      });
      try {
        if (loggedIn && saved.public !== isPublic) await api.setRecipePublic(saved.id, isPublic);
      } catch (err) {
        // A new recipe is already created, so saving again here would make a second one:
        // its page opens instead, and says whether it is public.
        if (id !== null) throw err;
      }
      router.push(`/recipe?id=${saved.id}`);
    } catch (err) {
      setError(errorMessage(t, err));
      setSaving(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    save(form);
  }

  // A finished translation is saved at once, with the user's unsaved edits.
  async function saveTranslation(into, content) {
    const next = withTranslation(latest.current, into, content);
    setForm(next);
    await save(next);
  }

  // A finished estimate is saved at once too, with the user's unsaved edits.
  async function saveNutrition(nutrition) {
    const next = withNutrition(latest.current, nutrition);
    setForm(next);
    await save(next);
  }

  // The form edits only the app's current language; the other language is kept as is,
  // unless the user translates into it.
  const current = form[lang];
  const other = lang === 'en' ? 'he' : 'en';

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

      <fieldset className={styles.nutritionFields}>
        <legend className="label">
          {t.nutrition} <span className="hint">({t.nutritionHint})</span>
        </legend>
        <div className={styles.nutritionRow}>
          {['calories', 'protein'].map((field) => (
            <div key={field}>
              <label className="label" htmlFor={field}>{t[field]}</label>
              <input
                id={field}
                className="field"
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                value={form[field]}
                onChange={(e) => setForm({ ...form, [field]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </fieldset>

      {loggedIn && (
        <div className={styles.visibility}>
          <p className={styles.visibilityText}>
            <strong>{isPublic ? t.publicLabel : `🔒 ${t.privateLabel}`}</strong>
            <span className="hint">{isPublic ? t.publicHint : t.privateHint}</span>
          </p>
          <button type="button" className={`button secondary ${styles.visibilityButton}`} disabled={saving || aiBusy} onClick={() => setIsPublic(!isPublic)}>
            {isPublic ? t.makePrivate : t.makePublic}
          </button>
        </div>
      )}

      {loggedIn && (
        <RecipeAiTools
          from={lang}
          content={toContent(current)}
          otherHasText={Boolean(form[other].name.trim() || form[other].ingredients.trim() || form[other].steps.trim())}
          hasNutrition={Boolean(form.calories.trim() || form.protein.trim())}
          recipeId={id}
          rescanId={id !== null && link ? id : null}
          onTranslated={(content) => saveTranslation(other, content)}
          onNutrition={saveNutrition}
          onBusyChange={setAiBusy}
        />
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className={styles.actions}>
        <button type="submit" className="button" disabled={saving || aiBusy}>{saving ? t.saving : t.save}</button>
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
