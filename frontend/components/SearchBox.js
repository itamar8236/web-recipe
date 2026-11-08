'use client';

import { useRef } from 'react';
import { useLanguage } from '@/components/Language';
import styles from './SearchBox.module.css';

export default function SearchBox({ value, onChange }) {
  const { t } = useLanguage();
  const input = useRef(null);

  return (
    <div className={styles.box} role="search">
      <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
      <input
        ref={input}
        type="search"
        className={`field ${styles.input}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Results update while typing, so Enter only has to close the phone keyboard.
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        placeholder={t.search}
        aria-label={t.search}
        enterKeyHint="search"
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className={styles.clear}
          aria-label={t.clearSearch}
          onClick={() => {
            onChange('');
            input.current.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
