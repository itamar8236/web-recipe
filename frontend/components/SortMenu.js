'use client';

import { useLanguage } from '@/components/Language';
import { SORTS } from '@/lib/sort';
import styles from './SortMenu.module.css';

// A small dropdown beside Search: the list keeps its usual order until someone picks
// another one. `first` is the usual order when it isn't one of SORTS (Browse's random).
export default function SortMenu({ value, onChange, first = null }) {
  const { t } = useLanguage();
  const options = first ? [first, ...SORTS] : SORTS;
  return (
    <label className={styles.menu}>
      <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
      </svg>
      <select
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t.sortLabel}
      >
        {options.map((sort) => (
          <option key={sort} value={sort}>{t.sortNames[sort]}</option>
        ))}
      </select>
    </label>
  );
}
