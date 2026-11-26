'use client';

import { useState } from 'react';
import { useLanguage } from '@/components/Language';
import styles from './SearchBox.module.css';

// A small button until it is needed, so the search takes almost no room on a phone. It
// starts open when it starts with a value (Browse opened from a shared recipe's link), but
// unfocused then, so a phone's keyboard doesn't cover the recipe the link is for.
export default function SearchBox({ value, onChange }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(value !== '' ? 'start' : false); // false | 'start' | 'tap'

  const icon = (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );

  if (!open) {
    return (
      <button type="button" className={`button secondary ${styles.openButton}`} onClick={() => setOpen('tap')}>
        {icon}
        {t.searchButton}
      </button>
    );
  }

  return (
    <div className={styles.box} role="search">
      {icon}
      <input
        type="search"
        className={`field ${styles.input}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Results update while typing, so Enter only has to close the phone keyboard.
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        onBlur={() => !value && setOpen(false)}
        placeholder={t.searchPlaceholder}
        aria-label={t.search}
        enterKeyHint="search"
        autoComplete="off"
        autoFocus={open === 'tap'}
      />
      <button
        type="button"
        className={styles.close}
        aria-label={t.closeSearch}
        onClick={() => {
          onChange('');
          setOpen(false);
        }}
      >
        ×
      </button>
    </div>
  );
}
