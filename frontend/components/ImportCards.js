'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from './Language';
import { errorMessage, stageMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './ImportCards.module.css';

const POLL_MS = 4000;

// The user's imports and the model state. It polls only while an import is running and
// the page is visible, so an idle Home makes no requests. `onRecipeReady` runs whenever an
// import finishes, because Home has no other way to learn there is a new recipe.
export function useImports(enabled, onRecipeReady) {
  const [imports, setImports] = useState([]);
  const [models, setModels] = useState(null);
  const latestRequest = useRef(0);
  const finishedIds = useRef(null); // null until the first answer
  const dismissedIds = useRef(new Set());
  const notifyReady = useRef(onRecipeReady);

  useEffect(() => {
    notifyReady.current = onRecipeReady;
  }, [onRecipeReady]);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const data = await api.getImports();
      if (request !== latestRequest.current) return; // a newer change or answer came first
      const finished = new Set(data.imports.filter((i) => i.status === 'done').map((i) => i.id));
      const hasNew = finishedIds.current && [...finished].some((id) => !finishedIds.current.has(id));
      finishedIds.current = finished;
      // A dismissal the backend hasn't finished yet must not bring its card back.
      setImports(data.imports.filter((i) => !dismissedIds.current.has(i.id)));
      setModels(data.models);
      if (hasNew) notifyReady.current();
    } catch {
      // A failed poll changes nothing: the next one tries again, and a lost session has
      // already brought back the login screen.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [enabled, refresh]);

  const anyRunning = imports.some((i) => i.status === 'running');
  useEffect(() => {
    if (!enabled || !anyRunning) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, anyRunning, refresh]);

  // A poll already on its way must not put the old list back over this card. `replacedId`
  // is the failed card a Retry replaces (a Retry is a new import).
  const addImport = useCallback((added, replacedId = null) => {
    latestRequest.current += 1;
    setImports((list) => [added, ...list.filter((i) => i.id !== added.id && i.id !== replacedId)]);
  }, []);

  const dismissImport = useCallback(
    async (id) => {
      dismissedIds.current.add(id);
      setImports((list) => list.filter((i) => i.id !== id));
      try {
        await api.dismissImport(id);
      } catch (error) {
        dismissedIds.current.delete(id);
        refresh();
        throw error;
      }
    },
    [refresh],
  );

  // When the models' daily limits reset, for the message that says to try again then.
  const backAt = models?.resetsAt;

  return { imports, backAt, refresh, addImport, dismissImport };
}

function recipeNameIn(lang, recipeName) {
  return recipeName[lang] || recipeName[lang === 'en' ? 'he' : 'en'];
}

function CloseButton({ label, disabled, onClick }) {
  return (
    <button type="button" className={styles.close} aria-label={label} disabled={disabled} onClick={onClick}>
      ×
    </button>
  );
}

function ImportCard({ item, backAt, busy, onDismiss, onRetry }) {
  const { lang, t } = useLanguage();
  const close = <CloseButton label={t.dismissImport} disabled={busy} onClick={() => onDismiss(item.id)} />;

  if (item.status === 'running') {
    return (
      <li className={`${styles.card} ${styles.running}`}>
        <div className={styles.body}>
          <p className={styles.title} dir="auto">{item.title || item.link}</p>
          <p className={styles.text}>{stageMessage(t, item.stage)}</p>
        </div>
      </li>
    );
  }

  if (item.status === 'done') {
    return (
      <li className={`${styles.card} ${styles.ready}`}>
        <div className={styles.body}>
          <p className={styles.title} dir="auto">{t.recipeReady(recipeNameIn(lang, item.recipeName))}</p>
          <div className={styles.actions}>
            {/* Opening also dismisses, so the card doesn't wait there after it was used. */}
            <Link href={`/recipe?id=${item.recipeId}`} className="button" onClick={() => onDismiss(item.id)}>
              {t.openRecipe}
            </Link>
          </div>
        </div>
        {close}
      </li>
    );
  }

  return (
    <li className={`${styles.card} ${styles.failed}`}>
      <div className={styles.body}>
        <p className={styles.title} dir="auto">{item.title || item.link}</p>
        <p className={styles.text}>{errorMessage(t, { code: item.error, retryAt: backAt })}</p>
        {item.retryable && (
          <div className={styles.actions}>
            <button type="button" className="button secondary" disabled={busy} onClick={() => onRetry(item.id)}>
              {t.retry}
            </button>
          </div>
        )}
      </div>
      {close}
    </li>
  );
}

export default function ImportCards({ imports, backAt, refresh, addImport, dismissImport }) {
  const { t } = useLanguage();
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  async function dismiss(id) {
    setError('');
    try {
      await dismissImport(id);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function retry(id) {
    setError('');
    setBusyId(id);
    try {
      addImport(await api.retryImport(id), id);
    } catch (err) {
      setError(errorMessage(t, { code: err.code, retryAt: backAt }));
    }
    await refresh();
    setBusyId((current) => (current === id ? null : current));
  }

  // A finished import whose recipe was deleted since has nothing left to show.
  const cards = imports.filter((item) => item.status !== 'done' || item.recipeId !== null);

  return (
    <div className={styles.area} aria-live="polite">
      {error && <p className="error" role="alert">{error}</p>}
      {cards.length > 0 && (
        <ul className={styles.list}>
          {cards.map((item) => (
            <ImportCard
              key={item.id}
              item={item}
              backAt={backAt}
              busy={busyId === item.id}
              onDismiss={dismiss}
              onRetry={retry}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
