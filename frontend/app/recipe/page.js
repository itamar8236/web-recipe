'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import HeartButton from '@/components/HeartButton';
import ConfirmDialog from '@/components/ConfirmDialog';
import { errorMessage, pickLanguage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './recipe.module.css';

function RecipeView() {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const id = Number(useSearchParams().get('id'));
  const [recipe, setRecipe] = useState(undefined); // undefined = loading, null = missing
  const [folderName, setFolderName] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0); // bumped by "Try again"
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRerun, setConfirmingRerun] = useState(false);
  const [busy, setBusy] = useState(null); // null | 'favorite' | 'delete' | 'rerun'
  const [error, setError] = useState('');
  const [models, setModels] = useState(null); // only known for a logged-in user
  const loggedIn = useAuth().status === 'user';

  useEffect(() => {
    if (!loggedIn) return undefined;
    let cancelled = false;
    // Only decides whether the re-run button shows, so a failure just leaves it hidden.
    api
      .getImports()
      .then((data) => {
        if (!cancelled) setModels(data.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [found, folders] = await Promise.all([api.getRecipe(id), api.getFolders()]);
        if (cancelled) return;
        setRecipe(found);
        setFolderName(folders.find((f) => f.id === found?.folderId)?.name ?? '');
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
          <Link href="/" className="button secondary">{t.back}</Link>
        </div>
      </div>
    );
  }
  if (recipe === undefined) return <p>{t.loading}</p>;
  if (recipe === null) {
    return (
      <>
        <p>{t.notFound}</p>
        <Link href="/" className="button secondary">{t.back}</Link>
      </>
    );
  }

  const content = pickLanguage(recipe, lang);
  // Recipe text may be in the other language than the UI, so set direction on the text itself.
  const contentLang = content.translated ? lang : lang === 'en' ? 'he' : 'en';
  const contentDir = contentLang === 'he' ? 'rtl' : 'ltr';

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

  async function rerun() {
    setConfirmingRerun(false);
    setBusy('rerun');
    setError('');
    try {
      await api.rerunRecipe(recipe.id);
      router.push('/');
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(null);
    }
  }

  const canRerun = models && recipe.sourceModel === models.basicModel && models.bestAvailable;

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
      <Link href="/" className={styles.back}>
        <span aria-hidden="true" className={styles.arrow}>←</span> {t.back}
      </Link>

      <header className={styles.head} lang={contentLang} dir={contentDir}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{content.name}</h1>
          <HeartButton active={recipe.favorite} disabled={busy !== null} onClick={toggleFavorite} />
        </div>
        <div className={styles.metaRow}>
          {folderName && <span className={styles.folder}>{folderName}</span>}
          <p className={styles.sourceRow}>
            {t.sourceLink}:{' '}
            {recipe.link ? (
              <a href={recipe.link} target="_blank" rel="noopener noreferrer" className={styles.source}>
                {new URL(recipe.link).hostname} ↗
              </a>
            ) : (
              <span>{t.manualSource}</span>
            )}
          </p>
        </div>
      </header>

      {!content.translated && <p className={styles.notice}>{t.notTranslated}</p>}

      <section className={styles.card}>
        <h2>{t.ingredients}</h2>
        <ul className={styles.ingredients} lang={contentLang} dir={contentDir}>
          {content.ingredients.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </section>

      <section className={styles.card}>
        <h2>{t.instructions}</h2>
        <ol className={styles.steps} lang={contentLang} dir={contentDir}>
          {content.steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {canRerun && (
        <button type="button" className="button secondary" disabled={busy !== null} onClick={() => setConfirmingRerun(true)}>
          {busy === 'rerun' ? t.rerunning : t.rerunBest}
        </button>
      )}

      <div className={styles.actions}>
        <Link href={`/recipe/edit?id=${recipe.id}`} className="button">{t.edit}</Link>
        <button type="button" className="button danger" disabled={busy !== null} onClick={() => setConfirmingDelete(true)}>
          {busy === 'delete' ? t.deleting : t.delete}
        </button>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          message={t.confirmDeleteRecipe}
          confirmLabel={t.delete}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {confirmingRerun && (
        <ConfirmDialog
          message={t.confirmRerun}
          confirmLabel={t.rerunBest}
          danger={false}
          onConfirm={rerun}
          onCancel={() => setConfirmingRerun(false)}
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
