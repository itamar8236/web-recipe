'use client';

import { useEffect, useRef } from 'react';
import { useLanguage } from './Language';
import styles from './ShareDialog.module.css';

// What to share: a link (for someone who uses the app) or the whole recipe as text (for
// anyone). Each choice says who it is for, so nobody has to know what "a link to Browse" means.
// `onPick` gets 'link' or 'text'; it must share at once, since the browser lets the share
// sheet open only right after a tap.
export default function ShareDialog({ onPick, onCancel }) {
  const { t } = useLanguage();
  const ref = useRef(null);

  useEffect(() => {
    ref.current.showModal();
  }, []);

  const choice = (kind, label, hint) => (
    <button type="button" className={styles.choice} onClick={() => onPick(kind)}>
      <span className={styles.label}>{label}</span>
      <span className={styles.hint}>{hint}</span>
    </button>
  );

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="share-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="share-title" className={styles.title}>{t.shareHow}</h2>
      <div className={styles.choices}>
        {choice('link', t.shareAsLink, t.shareAsLinkHint)}
        {choice('text', t.shareAsText, t.shareAsTextHint)}
      </div>
      <button type="button" className={`button secondary ${styles.cancel}`} onClick={onCancel}>
        {t.cancel}
      </button>
    </dialog>
  );
}
