'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import { errorMessage, formatTime } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './RecipeAiTools.module.css';

const hasText = (content) => Boolean(content.name.trim() || [...content.ingredients, ...content.steps].some((line) => line.trim()));

// The AI actions on the edit form, for a logged-in user: translate the language being
// written into the other one, and, for an imported recipe, scan its video again. Each has
// its own model choice: a translation is simple text work, so it starts on Basic and
// leaves the user's 5 daily best-model uses alone; a scan starts on Best, like an import.
// `content` is the language being written ({ name, ingredients[], steps[] }); the
// translation is handed to `onTranslated` and saved only with the form. `rescanId` is the
// recipe's id when it has a video link, otherwise null. `onBusyChange(true/false)` lets
// the form hold Save while a request runs.
export default function RecipeAiTools({ from, content, otherHasText, rescanId, onTranslated, onBusyChange }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [models, setModels] = useState({ translate: 'basic', rescan: 'best' });
  const [busy, setBusyState] = useState(null); // null | 'translate' | 'rescan'
  const [confirming, setConfirming] = useState(null); // null | 'translate' | 'rescan'
  const [askingApproval, setAskingApproval] = useState(false);
  const [backAt, setBackAt] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  function setBusy(value) {
    setBusyState(value);
    onBusyChange(value !== null);
  }

  function clearMessages() {
    setError('');
    setNote('');
    setAskingApproval(false);
  }

  async function translate() {
    setConfirming(null);
    clearMessages();
    setBusy('translate');
    try {
      onTranslated(await api.translateRecipe(from, content, models.translate));
      setNote(t.translated);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(null);
    }
  }

  // Like a new import: it runs in the background and its card shows on Home.
  async function rescan(useBasicModel) {
    setConfirming(null);
    clearMessages();
    setBusy('rescan');
    try {
      await api.rerunRecipe(rescanId, useBasicModel, models.rescan);
      router.push('/');
    } catch (err) {
      if (err.code === 'model_approval_needed') {
        setAskingApproval(true);
        // Only for the time in the question, so a failure just leaves it out.
        api.getImports().then(({ models }) => setBackAt(models.bestAvailableAt ?? models.resetsAt)).catch(() => {});
      } else {
        setError(errorMessage(t, err));
      }
      setBusy(null);
    }
  }

  function modelChoice(action) {
    const id = `ai-model-${action}`;
    return (
      <div className={styles.model}>
        <label className="label" htmlFor={id}>{t.modelChoice}</label>
        <select
          id={id}
          className={`field ${styles.modelSelect}`}
          value={models[action]}
          disabled={busy !== null}
          onChange={(event) => setModels({ ...models, [action]: event.target.value })}
        >
          <option value="best">{t.modelBest}</option>
          <option value="basic">{t.modelBasic}</option>
        </select>
      </div>
    );
  }

  return (
    <section className={styles.tools} aria-labelledby="ai-tools-title">
      <h2 id="ai-tools-title" className={styles.title}>{t.aiTools}</h2>

      <div className={styles.row}>
        <button
          type="button"
          className="button secondary"
          disabled={busy !== null || !hasText(content)}
          onClick={() => (otherHasText ? setConfirming('translate') : translate())}
        >
          {busy === 'translate' ? t.translating : t.translate}
        </button>
        {modelChoice('translate')}
      </div>

      {rescanId !== null && (
        <div className={styles.row}>
          <button type="button" className="button secondary" disabled={busy !== null} onClick={() => setConfirming('rescan')}>
            {busy === 'rescan' ? t.importStarting : t.rescan}
          </button>
          {modelChoice('rescan')}
        </div>
      )}

      {note && <p className="hint" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {askingApproval && (
        <div className={styles.approval} role="alert">
          <p>{t.approvalNeeded(formatTime(t, backAt))}</p>
          <div className={styles.actions}>
            <button type="button" className="button" onClick={() => rescan(true)}>{t.useBasicModel}</button>
            <button type="button" className="button secondary" onClick={() => setAskingApproval(false)}>{t.notNow}</button>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          message={confirming === 'translate' ? t.confirmTranslate : t.confirmRescan}
          confirmLabel={confirming === 'translate' ? t.translateShort : t.rescanShort}
          danger={false}
          onConfirm={confirming === 'translate' ? translate : () => rescan(false)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
