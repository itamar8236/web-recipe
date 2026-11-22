'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLanguage } from './Language';
import { errorMessage, pickLanguage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './BrowseCard.module.css';

// One recipe of another user in the Browse feed: its name, who saved it and its tags, the
// whole recipe behind "Show recipe", and one button that saves the user's own copy.
export default function BrowseCard({ recipe }) {
  const { lang, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(null); // the id of the user's copy, once saved
  const [error, setError] = useState('');

  const content = pickLanguage(recipe, lang);
  // The text may be in the other language than the UI, so the direction is set on it.
  const contentLang = content.translated ? lang : lang === 'en' ? 'he' : 'en';
  const contentDir = contentLang === 'he' ? 'rtl' : 'ltr';
  const detailsId = `browse-recipe-${recipe.id}`;

  async function save() {
    setSaving(true);
    setError('');
    try {
      setSavedId((await api.copyRecipe(recipe.id)).id);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={styles.card}>
      <div className={styles.top}>
        {recipe.picture && (
          // eslint-disable-next-line @next/next/no-img-element -- static export, no image optimizer
          <img src={recipe.picture.thumb} alt="" loading="lazy" className={styles.thumb} />
        )}
        <div className={styles.topText}>
          <h2 className={styles.name} lang={contentLang} dir={contentDir}>{content.name}</h2>

          <p className={styles.owner}>
            <svg className={styles.ownerIcon} viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
            </svg>
            <span className={styles.ownerName}>{t.savedBy(recipe.owner)}</span>
          </p>
        </div>
      </div>

      <p className={styles.meta}>
        {recipe.tags.map((name) => <span key={name} className={styles.tag}>{name}</span>)}
        <span>{t.ingredients}: {content.ingredients.length}</span>
        {recipe.link && (
          <a href={recipe.link} target="_blank" rel="noopener noreferrer" className={styles.source}>
            {new URL(recipe.link).hostname} ↗
          </a>
        )}
      </p>

      {open && (
        <div id={detailsId} className={styles.details}>
          {recipe.author && <p className={styles.author}>{t.author}: <bdi>{recipe.author}</bdi></p>}
          <h3>{t.ingredients}</h3>
          <ul lang={contentLang} dir={contentDir}>
            {content.ingredients.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
          <h3>{t.instructions}</h3>
          <ol lang={contentLang} dir={contentDir}>
            {content.steps.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className={styles.actions}>
        <button
          type="button"
          className={`button secondary ${styles.action}`}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          {open ? t.hideRecipe : t.showRecipe}
        </button>
        {savedId === null ? (
          <button type="button" className={`button ${styles.action}`} disabled={saving} onClick={save}>
            {saving ? t.saving : `+ ${t.saveCopy}`}
          </button>
        ) : (
          <p className={styles.saved} role="status">
            <span>✓ {t.savedCopy}</span>
            <Link href={`/recipe?id=${savedId}`} className={styles.openSaved}>{t.openRecipe}</Link>
          </p>
        )}
      </div>
    </article>
  );
}
