'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import { errorMessage } from '@/lib/i18n';
import styles from './FolderBar.module.css';

// `selected` is 'all', 'none' (recipes without a folder) or a folder id.
export default function FolderBar({ folders, recipes, selected, onSelect, onCreate, onRename, onDelete }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState(null); // null | 'new' | 'rename'
  const [name, setName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [hintFor, setHintFor] = useState(null); // folder id + recipe count the hint was requested for
  const [busy, setBusy] = useState(false); // a create, rename or delete is being saved
  const [error, setError] = useState('');
  const listRef = useRef(null);

  // On phones the pills scroll sideways; keep the selected one (e.g. a new folder) in view.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector('[aria-pressed="true"]');
    if (!active || list.scrollWidth <= list.clientWidth) return;
    active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selected, folders.length]);

  const countIn = (folderId) => recipes.filter((r) => r.folderId === folderId).length;
  const unfiledCount = countIn(null);
  const selectedFolder = folders.find((f) => f.id === selected);
  const selectedIsEmpty = selectedFolder ? countIn(selectedFolder.id) === 0 : false;
  // The hint belongs to one attempt, so it disappears when the folder or its contents change.
  const hintKey = selectedFolder ? `${selectedFolder.id}:${countIn(selectedFolder.id)}` : null;
  const showNotEmptyHint = hintKey !== null && hintFor === hintKey;

  function startEditing(nextMode) {
    setMode(nextMode);
    setName(nextMode === 'rename' ? selectedFolder.name : '');
    setError('');
  }

  // Runs a save; on failure the form stays open with the message, so nothing typed is lost.
  async function save(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorMessage(t, err, t.errFolderNameRequired));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    const ok = await save(() => (mode === 'new' ? onCreate(name) : onRename(selectedFolder.id, name)));
    if (ok) setMode(null);
  }

  function pill(key, label, count, value) {
    const active = selected === value;
    return (
      <li key={key}>
        <button type="button" className={`${styles.pill} ${active ? styles.active : ''}`} aria-pressed={active} onClick={() => { setError(''); onSelect(value); }}>
          <span className={styles.pillName}>{label}</span>
          <span className={styles.count}>{count}</span>
        </button>
      </li>
    );
  }

  return (
    <nav className={styles.bar} aria-label={t.folders}>
      <h2 className={styles.heading}>{t.folders}</h2>
      <ul className={styles.list} ref={listRef}>
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
            <button type="submit" className="button" disabled={!name.trim() || busy}>{busy ? t.saving : t.save}</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setMode(null)}>{t.cancel}</button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={`button secondary ${styles.newFolder}`} disabled={busy} onClick={() => startEditing('new')}>+ {t.newFolder}</button>
          {selectedFolder && (
            <>
              <button type="button" className="button secondary" disabled={busy} onClick={() => startEditing('rename')}>{t.rename}</button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                // aria-disabled (not disabled) so a tap still fires and can explain why nothing happens.
                aria-disabled={!selectedIsEmpty}
                aria-describedby={showNotEmptyHint ? 'folder-not-empty' : undefined}
                onClick={() => (selectedIsEmpty ? setConfirmingDelete(true) : setHintFor(hintKey))}
              >
                {busy ? t.deleting : t.delete}
              </button>
            </>
          )}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {!mode && selectedFolder && !selectedIsEmpty && showNotEmptyHint && (
        <p id="folder-not-empty" className="hint">{t.folderNotEmpty}</p>
      )}

      {confirmingDelete && selectedFolder && selectedIsEmpty && (
        <ConfirmDialog
          message={t.confirmDeleteFolder}
          confirmLabel={t.delete}
          onConfirm={async () => {
            setConfirmingDelete(false);
            await save(() => onDelete(selectedFolder.id));
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </nav>
  );
}
