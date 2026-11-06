'use client';

import { useState } from 'react';
import { useLanguage } from './Language';
import styles from './FolderBar.module.css';

// `selected` is 'all', 'none' (recipes without a folder) or a folder id.
export default function FolderBar({ folders, recipes, selected, onSelect, onCreate, onRename, onDelete }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState(null); // null | 'new' | 'rename'
  const [name, setName] = useState('');

  const countIn = (folderId) => recipes.filter((r) => r.folderId === folderId).length;
  const unfiledCount = countIn(null);
  const selectedFolder = folders.find((f) => f.id === selected);

  function startEditing(nextMode) {
    setMode(nextMode);
    setName(nextMode === 'rename' ? selectedFolder.name : '');
  }

  async function submit(event) {
    event.preventDefault();
    if (!name.trim()) return;
    if (mode === 'new') await onCreate(name);
    else await onRename(selectedFolder.id, name);
    setMode(null);
  }

  function pill(key, label, count, value) {
    const active = selected === value;
    return (
      <li key={key}>
        <button type="button" className={`${styles.pill} ${active ? styles.active : ''}`} aria-pressed={active} onClick={() => onSelect(value)}>
          <span className={styles.pillName}>{label}</span>
          <span className={styles.count}>{count}</span>
        </button>
      </li>
    );
  }

  return (
    <nav className={styles.bar} aria-label={t.folders}>
      <ul className={styles.list}>
        {pill('all', t.allRecipes, recipes.length, 'all')}
        {folders.map((folder) => pill(folder.id, folder.name, countIn(folder.id), folder.id))}
        {unfiledCount > 0 && pill('none', t.noFolder, unfiledCount, 'none')}
      </ul>

      {mode ? (
        <form className={styles.form} onSubmit={submit}>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.folderName}
            aria-label={t.folderName}
            autoFocus
          />
          <div className={styles.actions}>
            <button type="submit" className="button" disabled={!name.trim()}>{t.save}</button>
            <button type="button" className="button secondary" onClick={() => setMode(null)}>{t.cancel}</button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <button type="button" className="button secondary" onClick={() => startEditing('new')}>+ {t.newFolder}</button>
          {selectedFolder && (
            <>
              <button type="button" className="button secondary" onClick={() => startEditing('rename')}>{t.rename}</button>
              <button
                type="button"
                className="button danger"
                onClick={() => window.confirm(t.confirmDeleteFolder) && onDelete(selectedFolder.id)}
              >
                {t.delete}
              </button>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
