'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './ImportDialog.module.css';

// What "+ Add recipe" opens for a logged-in user. It asks only for the link: the backend
// works out the site and which model reads it. Only "Write it manually" opens the manual
// form; closing the dialog in any other way leaves the user on Home. `backAt` is when a
// used-up daily limit resets, for the error that mentions it.
export default function ImportDialog({ backAt, manualHref, onClose, onStarted, onModelsStale }) {
  const { t } = useLanguage();
  const router = useRouter();
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  async function start() {
    setBusy(true);
    setError('');
    try {
      onStarted(await api.startImport(url));
    } catch (err) {
      setError(errorMessage(t, { code: err.code, retryAt: backAt }));
      if (err.code === 'quota') onModelsStale();
      setBusy(false);
    }
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
          <h2 id="import-title" className={styles.title}>{t.addFromVideo}</h2>
          <button type="button" className={styles.close} aria-label={t.close} disabled={busy} onClick={close}>
            ×
          </button>
        </div>

        <form className={styles.form} onSubmit={submit}>
          <div>
            <label className="label" htmlFor="import-link">{t.videoLink}</label>
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
              placeholder={t.videoLinkPlaceholder}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError('');
              }}
            />
            {error && <p className="error" role="alert">{error}</p>}
          </div>

          <div className={styles.actions}>
            <button type="submit" className="button" disabled={busy || !url.trim()}>
              {busy ? t.importStarting : t.importButton}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={writeManually}>
              {t.writeManually}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
