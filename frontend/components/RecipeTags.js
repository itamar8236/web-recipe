'use client';

import { useState } from 'react';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './RecipeTags.module.css';

// A recipe's tags on its own page. Every tap saves at once, so there is no edit mode:
// tapping a tag removes it, and "Add tag" opens a panel with the user's other tags and a
// field for a new one. `allTags` is every tag the user has; `onChange` gets the answer of
// api.setRecipeTags ({ recipe, tags }).
export default function RecipeTags({ recipe, allTags, onChange }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const own = allTags.filter((tag) => recipe.tagIds.includes(tag.id));
  const others = allTags.filter((tag) => !recipe.tagIds.includes(tag.id));

  // Returns whether it was saved; on failure the tags stay as they were, with the message.
  async function save(names) {
    setBusy(true);
    setError('');
    try {
      onChange(await api.setRecipeTags(recipe.id, names));
      return true;
    } catch (err) {
      setError(errorMessage(t, err, t.errTagNameRequired));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const ownNames = own.map((tag) => tag.name);
  const add = (tagName) => save([...ownNames, tagName]);
  const remove = (tag) => save(ownNames.filter((n) => n !== tag.name));

  async function addNew(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    if (await add(name)) setName('');
  }

  return (
    <section className={styles.tags} aria-label={t.tags}>
      <ul className={styles.list}>
        {own.map((tag) => (
          <li key={tag.id}>
            <button
              type="button"
              className={styles.chip}
              disabled={busy}
              aria-label={t.removeTag(tag.name)}
              title={t.removeTag(tag.name)}
              onClick={() => remove(tag)}
            >
              <span className={styles.chipName}>{tag.name}</span>
              <span aria-hidden="true" className={styles.x}>×</span>
            </button>
          </li>
        ))}
        {!open && (
          <li>
            <button type="button" className={`${styles.chip} ${styles.addChip}`} onClick={() => setOpen(true)}>
              + {t.addTag}
            </button>
          </li>
        )}
      </ul>

      {open && (
        <div className={styles.panel}>
          {others.length > 0 && (
            <div>
              <p className={`hint ${styles.panelLabel}`}>{t.yourTags}</p>
              <ul className={styles.list}>
                {others.map((tag) => (
                  <li key={tag.id}>
                    <button type="button" className={`${styles.chip} ${styles.addChip}`} disabled={busy} onClick={() => add(tag.name)}>
                      <span aria-hidden="true">+</span>
                      <span className={styles.chipName}>{tag.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form className={styles.newTag} onSubmit={addNew}>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.newTagPlaceholder}
              aria-label={t.tagName}
              maxLength={100}
            />
            <button type="submit" className="button" disabled={!name.trim() || busy}>{t.add}</button>
          </form>
          <button
            type="button"
            className={`button secondary ${styles.done}`}
            onClick={() => {
              setOpen(false);
              setName('');
              setError('');
            }}
          >
            {t.done}
          </button>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
