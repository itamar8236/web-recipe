'use client';

import { useEffect, useRef } from 'react';
import { useLanguage } from './Language';
import styles from './ConfirmDialog.module.css';

// An in-page "are you sure?" box. window.confirm() is not used because some browsers
// and in-app web views block it, which made it silently return false.
export default function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel }) {
  const { t } = useLanguage();
  const ref = useRef(null);

  useEffect(() => {
    ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <p className={styles.message}>{message}</p>
      <div className={styles.actions}>
        <button type="button" className={`button danger ${styles.confirm}`} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" className="button secondary" onClick={onCancel} autoFocus>{t.cancel}</button>
      </div>
    </dialog>
  );
}
