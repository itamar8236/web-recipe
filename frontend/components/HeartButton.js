'use client';

import { useLanguage } from './Language';
import styles from './HeartButton.module.css';

export default function HeartButton({ active, onClick, className = '' }) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      className={`${styles.heart} ${active ? styles.active : ''} ${className}`}
      aria-pressed={active}
      aria-label={active ? t.removeFavorite : t.addFavorite}
      title={active ? t.removeFavorite : t.addFavorite}
      onClick={onClick}
    >
      {active ? '♥' : '♡'}
    </button>
  );
}
