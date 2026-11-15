'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import styles from './TagBar.module.css';

// The filter on Home. `selected` is 'all', 'none' (recipes without a tag) or a tag id.
// Tags are added and removed on each recipe's own page; here one can only be renamed.
export default function TagBar({ tags, recipes, selected, onSelect, onRename }) {
  const { t } = useLanguage();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef(null);

  // On phones the pills scroll sideways; keep the selected one in view.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector('[aria-pressed="true"]');
    if (!active || list.scrollWidth <= list.clientWidth) return;
    active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selected, tags.length]);

  const countWith = (tagId) => recipes.filter((r) => r.tagIds.includes(tagId)).length;
  const untaggedCount = recipes.filter((r) => r.tagIds.length === 0).length;
  const selectedTag = tags.find((tag) => tag.id === selected);

  function startRenaming() {
    setRenaming(true);
    setName(selectedTag.name);
    setError('');
  }

  // On failure the form stays open with the message, so nothing typed is lost.
  async function submit(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onRename(selectedTag.id, name);
      setRenaming(false);
    } catch (err) {
      setError(errorMessage(t, err, t.errTagNameRequired));
    } finally {
      setBusy(false);
    }
  }

  function pill(key, label, count, value) {
    const active = selected === value;
    return (
      <li key={key}>
        <button
          type="button"
          className={`${styles.pill} ${active ? styles.active : ''}`}
          aria-pressed={active}
          onClick={() => {
            setError('');
            setRenaming(false);
            onSelect(value);
          }}
        >
          <span className={styles.pillName}>{label}</span>
          <span className={styles.count}>{count}</span>
        </button>
      </li>
    );
  }

  return (
    <nav className={styles.bar} aria-label={t.tags}>
      <h2 className={styles.heading}>{t.tags}</h2>
      <ul className={styles.list} ref={listRef}>
        {pill('all', t.allRecipes, recipes.length, 'all')}
        {tags.map((tag) => pill(tag.id, tag.name, countWith(tag.id), tag.id))}
        {untaggedCount > 0 && pill('none', t.noTags, untaggedCount, 'none')}
      </ul>

      {selectedTag && renaming && (
        <form className={styles.form} onSubmit={submit}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.tagName}
            aria-label={t.tagName}
            maxLength={100}
            autoFocus
          />
          <div className={styles.actions}>
            <button type="submit" className="button" disabled={!name.trim() || busy}>{busy ? t.saving : t.save}</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setRenaming(false)}>{t.cancel}</button>
          </div>
        </form>
      )}
      {selectedTag && !renaming && (
        <div className={styles.actions}>
          <button type="button" className="button secondary" onClick={startRenaming}>{t.rename}</button>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </nav>
  );
}
