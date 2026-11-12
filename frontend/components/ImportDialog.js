'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import { errorMessage, formatTime } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './ImportDialog.module.css';

// What "+ Add recipe" opens for a logged-in user. It asks only for the link: the backend
// works out the site. Declining the prompt in any way means writing the recipe by hand.
export default function ImportDialog({ models, backAt, manualHref, onStarted, onModelsStale }) {
  const { t } = useLanguage();
  const router = useRouter();
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [askingApproval, setAskingApproval] = useState(false);
  const [model, setModel] = useState('best');

  useEffect(() => {
    ref.current.showModal();
    // Set by hand because opening a dialog moves focus to its first button, the ×.
    inputRef.current.focus();
  }, []);

  function writeManually() {
    if (!busy) router.push(manualHref);
  }

  async function start(useBasicModel) {
    setBusy(true);
    setError('');
    setAskingApproval(false);
    try {
      onStarted(await api.startImport(url, useBasicModel, model));
    } catch (err) {
      if (err.code === 'model_approval_needed') setAskingApproval(true);
      else setError(errorMessage(t, { code: err.code, retryAt: backAt }));
      if (err.code === 'model_approval_needed' || err.code === 'quota') onModelsStale();
      setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (url.trim()) start(false);
  }

  const onBasicModel = models?.basicApproved && !models.bestAvailable;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        writeManually();
      }}
      // Only a tap on the backdrop lands on the dialog itself; its content has a wrapper.
      onClick={(event) => {
        if (event.target === event.currentTarget) writeManually();
      }}
    >
      <div className={styles.content}>
        <div className={styles.head}>
          <h2 id="import-title" className={styles.title}>{t.addFromVideo}</h2>
          <button type="button" className={styles.close} aria-label={t.close} disabled={busy} onClick={writeManually}>
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

          <div className={styles.model}>
            <label className="label" htmlFor="import-model">{t.modelChoice}</label>
            <select
              id="import-model"
              className={`field ${styles.modelSelect}`}
              value={model}
              disabled={busy}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="best">{t.modelBest}</option>
              <option value="basic">{t.modelBasic}</option>
            </select>
          </div>

          {models && <p className="hint">{t.bestLeftToday(Math.min(models.bestLeftForUser, models.bestLeftToday))}</p>}
          {onBasicModel && <p className="hint">{t.usingBasicModel(formatTime(t, backAt))}</p>}

          {askingApproval ? (
            <div className={styles.approval} role="alert">
              <p>{t.approvalNeeded(formatTime(t, backAt))}</p>
              <div className={styles.actions}>
                <button type="button" className="button" onClick={() => start(true)}>{t.useBasicModel}</button>
                <button type="button" className="button secondary" onClick={() => setAskingApproval(false)}>{t.notNow}</button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              <button type="submit" className="button" disabled={busy || !url.trim()}>
                {busy ? t.importStarting : t.importButton}
              </button>
              <button type="button" className="button secondary" disabled={busy} onClick={writeManually}>
                {t.writeManually}
              </button>
            </div>
          )}
        </form>
      </div>
    </dialog>
  );
}
