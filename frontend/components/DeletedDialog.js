'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { errorMessage, pickLanguage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './DeletedDialog.module.css';

const DAY = 24 * 60 * 60 * 1000;

// "Recently deleted": the user's deleted recipes, each with a Restore button, until they
// are deleted for good 30 days after deleting. A restored recipe leaves the list, and
// `onRestored` gets { recipe, tags } from the backend so Home can show it at once.
export default function DeletedDialog({ recipes, onRestored, onClose }) {
  const { lang, t } = useLanguage();
  const ref = useRef(null);
  const [restoring, setRestoring] = useState(null); // the id being restored
  const [error, setError] = useState('');
  // Read once when the dialog opens: the days left can't change while it is open.
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    ref.current.showModal();
  }, []);

  async function restore(id) {
    setRestoring(id);
    setError('');
    try {
      onRestored(id, await api.restoreRecipe(id));
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="deleted-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="deleted-title" className={styles.title}>{t.recentlyDeleted}</h2>
      <p className="hint">{t.recentlyDeletedHint}</p>

      {recipes.length === 0 ? (
        <p className={styles.empty}>{t.recentlyDeletedEmpty}</p>
      ) : (
        <ul className={styles.list}>
          {recipes.map((recipe) => {
            const { name, translated } = pickLanguage(recipe, lang);
            const nameLang = translated ? lang : lang === 'en' ? 'he' : 'en';
            const daysLeft = Math.max(1, Math.ceil((recipe.expiresAt - openedAt) / DAY));
            return (
              <li key={recipe.id} className={styles.item}>
                <div className={styles.text}>
                  <strong lang={nameLang} dir={nameLang === 'he' ? 'rtl' : 'ltr'}>{name}</strong>
                  <span className="hint">{t.goneIn(daysLeft)}</span>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={restoring !== null}
                  onClick={() => restore(recipe.id)}
                >
                  {restoring === recipe.id ? t.restoring : t.restore}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <div className={styles.actions}>
        <button type="button" className="button secondary" onClick={onClose}>{t.close}</button>
      </div>
    </dialog>
  );
}
