'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './RecipeAiTools.module.css';

const hasText = (content) => Boolean(content.name.trim() || [...content.ingredients, ...content.steps].some((line) => line.trim()));

// The AI actions on the edit form, for a logged-in user: translate the language being
// written into the other one, and, for an imported recipe, scan its video again. Each has
// its own model choice: a translation is simple text work, so it starts on Basic and
// leaves the user's 5 daily best-model uses alone; a scan starts on Best, like an import.
// Nothing asks for approval: when the best model can't be used, the basic one answers.
// `content` is the language being written ({ name, ingredients[], steps[] }); the
// translation is handed to `onTranslated` and saved only with the form. `rescanId` is the
// recipe's id when it has a video link, otherwise null; `recipeId` is its id, or null for
// a recipe not saved yet. `onBusyChange(true/false)` lets the form hold Save while a
// request runs.
export default function RecipeAiTools({ from, content, otherHasText, recipeId, rescanId, onTranslated, onBusyChange }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [models, setModels] = useState({ translate: 'basic', rescan: 'best' });
  const [busy, setBusyState] = useState(null); // null | 'translate' | 'rescan'
  const [confirming, setConfirming] = useState(null); // null | 'translate' | 'rescan'
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  function setBusy(value) {
    setBusyState(value);
    onBusyChange(value !== null);
  }

  function clearMessages() {
    setError('');
    setNote('');
  }

  async function translate() {
    setConfirming(null);
    clearMessages();
    setBusy('translate');
    try {
      const result = await api.translateRecipe(from, content, models.translate, recipeId);
      onTranslated(result.content);
      // Asked for Best but got Basic: say so, since it may read less well.
      setNote(models.translate === 'best' && result.model === 'basic' ? t.translatedBasic : t.translated);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(null);
    }
  }

  // Like a new import: it runs in the background and its card shows on Home.
  async function rescan() {
    setConfirming(null);
    clearMessages();
    setBusy('rescan');
    try {
      await api.rerunRecipe(rescanId, models.rescan);
      router.push('/');
    } catch (err) {
      setError(errorMessage(t, err));
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

      {confirming && (
        <ConfirmDialog
          message={confirming === 'translate' ? t.confirmTranslate : t.confirmRescan}
          confirmLabel={confirming === 'translate' ? t.translateShort : t.rescanShort}
          danger={false}
          onConfirm={confirming === 'translate' ? translate : rescan}
          onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
