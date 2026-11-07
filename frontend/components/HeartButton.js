'use client';

import { useLanguage } from './Language';
import styles from './HeartButton.module.css';

// `disabled` while the change is being saved, so quick taps can't race each other.
export default function HeartButton({ active, disabled = false, onClick, className = '' }) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      className={`${styles.heart} ${active ? styles.active : ''} ${className}`}
      aria-pressed={active}
      aria-label={active ? t.removeFavorite : t.addFavorite}
      title={active ? t.removeFavorite : t.addFavorite}
      disabled={disabled}
      onClick={onClick}
    >
      {active ? '♥' : '♡'}
    </button>
  );
}
