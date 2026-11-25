'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import BackLink from '@/components/BackLink';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import HeartButton from '@/components/HeartButton';
import ConfirmDialog from '@/components/ConfirmDialog';
import RecipeAiTools from '@/components/RecipeAiTools';
import RecipePicture from '@/components/RecipePicture';
import RecipeTags from '@/components/RecipeTags';
import { errorMessage, pickLanguage } from '@/lib/i18n';
import { hasForeignScript } from '@/lib/foreignScript';
import { scaleIngredient } from '@/lib/scale';
import * as api from '@/lib/api';
import styles from './recipe.module.css';

// The amounts the ingredients can be shown at. Only for viewing, like a substitute: never saved.
const FACTORS = [
  { value: 0.5, label: '½×' },
  { value: 1, label: '1×' },
  { value: 1.5, label: '1.5×' },
  { value: 2, label: '2×' },
  { value: 3, label: '3×' },
];

function RecipeView() {
  const { lang, setLang, t } = useLanguage();
  const router = useRouter();
  const id = Number(useSearchParams().get('id'));
  const [recipe, setRecipe] = useState(undefined); // undefined = loading, null = missing
  const [tags, setTags] = useState([]); // every tag the user has
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0); // bumped by "Try again"
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(null); // null | 'favorite' | 'delete'
  const [factor, setFactor] = useState(1);
  const [multiplyOpen, setMultiplyOpen] = useState(false);
  // A guest's recipes are never sent anywhere, so public or private means nothing to them,
  // and the AI tools need an account. Public or private is changed in the edit form; this
  // page only says which it is.
  const loggedIn = useAuth().status === 'user';
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [found, loadedTags] = await Promise.all([api.getRecipe(id), api.getTags()]);
        if (cancelled) return;
        setRecipe(found);
        setTags(loadedTags);
      } catch (err) {
        if (!cancelled) setLoadError(err);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (loadError) {
    return (
      <div role="alert">
        <p className="error">{errorMessage(t, loadError)}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className="button"
            onClick={() => {
              setLoadError(null);
              setAttempt(attempt + 1);
            }}
          >
            {t.retry}
          </button>
          <BackLink className="button secondary">{t.back}</BackLink>
        </div>
      </div>
    );
  }
  if (recipe === undefined) return <p>{t.loading}</p>;
  if (recipe === null) {
    return (
      <>
        <p>{t.notFound}</p>
        <BackLink className="button secondary">{t.back}</BackLink>
      </>
    );
  }

  const content = pickLanguage(recipe, lang);
  // Recipe text may be in the other language than the UI, so set direction on the text itself.
  const contentLang = content.translated ? lang : lang === 'en' ? 'he' : 'en';
  const contentDir = contentLang === 'he' ? 'rtl' : 'ltr';
  // When the shown text has letters of a third language, point to the AI tools that fix it:
  // translating from the other version (only if it exists and is clean) or scanning the link
  // again. Both need an account, so a guest never sees this.
  const otherLang = lang === 'en' ? 'he' : 'en';
  const canTranslateFromOther = content.translated && recipe[otherLang].name && !hasForeignScript(recipe[otherLang]);
  const showForeignNotice = loggedIn && hasForeignScript(content) && (canTranslateFromOther || recipe.link);

  async function remove() {
    setConfirmingDelete(false);
    setBusy('delete');
    setError('');
    try {
      await api.deleteRecipe(recipe.id);
      router.push('/');
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(null);
    }
  }

  // The heart changes at once and changes back if saving fails.
  async function toggleFavorite() {
    const favorite = !recipe.favorite;
    setBusy('favorite');
    setError('');
    setRecipe({ ...recipe, favorite });
    try {
      await api.setFavorite(recipe.id, favorite);
    } catch (err) {
      setRecipe({ ...recipe, favorite: !favorite });
      setError(errorMessage(t, err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={styles.recipe}>
      <BackLink className={styles.back}>
        <span aria-hidden="true" className={styles.arrow}>←</span> {t.back}
      </BackLink>

      {showForeignNotice && (
        <div className={styles.notice} role="note">
          <p className={styles.noticeText}>
            {t.foreignText}{' '}
            {canTranslateFromOther ? t.foreignTranslate : t.foreignRescanOnly}
            {canTranslateFromOther && recipe.link && ` ${t.foreignRescan}`}
          </p>
          {canTranslateFromOther && (
            <button type="button" className="button secondary" onClick={() => setLang(otherLang)}>
              {t.switchToOther}
            </button>
          )}
        </div>
      )}

      <header className={styles.head} lang={contentLang} dir={contentDir}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{content.name}</h1>
          <HeartButton active={recipe.favorite} disabled={busy !== null} onClick={toggleFavorite} />
        </div>
        <div className={styles.metaRow}>
          <p className={styles.sourceRow}>
            {t.sourceLink}:{' '}
            {recipe.link ? (
              <a href={recipe.link} target="_blank" rel="noopener noreferrer" className={styles.source}>
                {new URL(recipe.link).hostname} ↗
              </a>
            ) : (
              <span>{recipe.fromPhoto ? t.photoSource : t.manualSource}</span>
            )}
          </p>
          {recipe.author && (
            <p className={styles.sourceRow}>
              {t.author}: <bdi>{recipe.author}</bdi>
            </p>
          )}
          {loggedIn && (
            <span className={styles.visibilityLabel}>{recipe.public ? t.publicLabel : `🔒 ${t.privateLabel}`}</span>
          )}
        </div>
      </header>

      {recipe.picture && <RecipePicture picture={recipe.picture} name={content.name} />}

      <RecipeTags
        recipe={recipe}
        allTags={tags}
        onChange={(saved) => {
          // Only the tags are taken, so a heart tapped meanwhile isn't undone.
          setRecipe((current) => ({ ...current, tagIds: saved.recipe.tagIds }));
          setTags(saved.tags);
        }}
      />

      {!content.translated && <p className={styles.notice}>{t.notTranslated}</p>}

      <section className={styles.card}>
        <h2 className={styles.ingredientsTitle}>
          {t.ingredients}
          {factor !== 1 && <span className={styles.factorBadge} dir="ltr">{FACTORS.find((f) => f.value === factor).label}</span>}
        </h2>
        {factor !== 1 && <p className={styles.multipliedNote}>{t.multipliedNote}</p>}
        <ul className={styles.ingredients} lang={contentLang} dir={contentDir}>
          {content.ingredients.map((item, i) => <li key={i}>{scaleIngredient(item, factor)}</li>)}
        </ul>
        {/* Rarely used, so it waits quietly under the list until asked for. */}
        {content.ingredients.length > 0 && !multiplyOpen && (
          <button type="button" className={`button secondary ${styles.multiplyOpen}`} onClick={() => setMultiplyOpen(true)}>
            × {t.multiplyAmounts}
          </button>
        )}
        {multiplyOpen && (
          <div className={styles.multiply} role="group" aria-label={t.multiplyAmounts}>
            <span className={styles.multiplyLabel}>{t.multiplyAmounts}:</span>
            {FACTORS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`${styles.factor} ${factor === value ? styles.factorActive : ''}`}
                aria-pressed={factor === value}
                onClick={() => setFactor(value)}
              >
                <span dir="ltr">{label}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h2>{t.instructions}</h2>
        <ol className={styles.steps} lang={contentLang} dir={contentDir}>
          {content.steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      </section>

      {(recipe.calories !== null || recipe.protein !== null) && (
        <section className={styles.card}>
          <h2>{t.nutrition}</h2>
          <ul className={styles.nutrition}>
            {recipe.calories !== null && <li>{t.caloriesValue(recipe.calories)}</li>}
            {recipe.protein !== null && <li>{t.proteinValue(recipe.protein)}</li>}
          </ul>
          <p className={styles.nutritionNote}>{t.nutritionAiNote}</p>
        </section>
      )}

      {loggedIn && (
        <RecipeAiTools
          recipe={recipe}
          lang={lang}
          // Only the saved text and numbers are taken, so a heart tapped meanwhile isn't undone.
          onSaved={(saved) => setRecipe((current) => ({ ...current, en: saved.en, he: saved.he, calories: saved.calories, protein: saved.protein }))}
        />
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className={styles.actions}>
        <Link href={`/recipe/edit?id=${recipe.id}`} className="button">{t.edit}</Link>
        <button type="button" className="button danger" disabled={busy !== null} onClick={() => setConfirmingDelete(true)}>
          {busy === 'delete' ? t.deleting : t.delete}
        </button>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          message={loggedIn ? t.confirmDeleteRecipeBin : t.confirmDeleteRecipe}
          confirmLabel={t.delete}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </article>
  );
}

export default function RecipePage() {
  return (
    <Suspense fallback={null}>
      <RecipeView />
    </Suspense>
  );
}
