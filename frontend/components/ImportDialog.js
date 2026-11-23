'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import { importPhotos } from '@/lib/photo';
import styles from './ImportDialog.module.css';

// What "+ Add recipe" opens for a logged-in user. Its main action is the link: the backend
// works out the site and which model reads it. Under it, "Choose photos" opens the phone's
// own chooser (gallery, camera or files; no `capture`, so the gallery is offered) for 1 to 7
// pictures of one written recipe, which are uploaded at once. Only "Write it manually" opens
// the manual form; closing the dialog in any other way leaves the user on Home. A small copy
// of each photo is sent too, and the backend keeps the one the model chose as the recipe's
// picture (importPhotos in lib/photo.js). `backAt` is
// when a used-up daily limit resets, for the error that mentions it.
export default function ImportDialog({ backAt, manualHref, onClose, onStarted, onModelsStale }) {
  const { t } = useLanguage();
  const router = useRouter();
  const ref = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  // null, 'link' or 'photo': what is being sent, so only that button says so.
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    ref.current.showModal();
    // Set by hand because opening a dialog moves focus to its first button, the ×.
    inputRef.current.focus();
  }, []);

  function writeManually() {
    if (!busy) router.push(manualHref);
  }

  function close() {
    if (!busy) onClose();
  }

  // The dialog stays open, with every button off, until the backend has the link or the
  // whole picture (a few seconds for a full-size photo on mobile data).
  async function send(what, startImport) {
    setBusy(what);
    setError('');
    try {
      onStarted(await startImport());
    } catch (err) {
      setError(errorMessage(t, { code: err.code, retryAt: backAt }));
      if (err.code === 'quota') onModelsStale();
      setBusy(null);
    }
  }

  const start = () => send('link', () => api.startImport(url));

  function photosChosen(event) {
    // In the order the browser lists them (usually the order they were picked); the model
    // puts the recipe together whatever the order.
    const files = [...event.target.files];
    // Cleared, so choosing the same pictures again (for a second read) still fires.
    event.target.value = '';
    if (files.length) send('photo', async () => (await importPhotos(files)).card);
  }

  function submit(event) {
    event.preventDefault();
    if (url.trim()) start();
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      // Only a tap on the backdrop lands on the dialog itself; its content has a wrapper.
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className={styles.content}>
        <div className={styles.head}>
          <h2 id="import-title" className={styles.title}>{t.addRecipeTitle}</h2>
          <button type="button" className={styles.close} aria-label={t.close} disabled={busy !== null} onClick={close}>
            ×
          </button>
        </div>

        <form className={styles.form} onSubmit={submit}>
          <div>
            <label className="label" htmlFor="import-link">{t.importLink}</label>
            <input
              id="import-link"
              ref={inputRef}
              className="field"
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t.importLinkPlaceholder}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError('');
              }}
            />
            {error && <p className="error" role="alert">{error}</p>}
          </div>

          <div className={styles.actions}>
            <button type="submit" className="button" disabled={busy !== null || !url.trim()}>
              {busy === 'link' ? t.importStarting : t.importButton}
            </button>
            <button type="button" className="button secondary" disabled={busy !== null} onClick={writeManually}>
              {t.writeManually}
            </button>
          </div>

          <button
            type="button"
            className={`button secondary ${styles.photo}`}
            disabled={busy !== null}
            onClick={() => fileRef.current.click()}
          >
            {busy === 'photo' ? t.uploadingPhoto : t.choosePhoto}
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={photosChosen} />
        </form>
      </div>
    </dialog>
  );
}
