'use client';

import Link from 'next/link';
import { useLanguage } from './Language';
import styles from './ModeTabs.module.css';

// The switch between the user's own recipes (Home) and other users' recipes (Browse).
// `current` is 'mine' or 'browse'. Shown only to a logged-in user: browsing needs an account.
export default function ModeTabs({ current }) {
  const { t } = useLanguage();
  const tabs = [
    { key: 'mine', href: '/', label: t.myRecipesTab },
    { key: 'browse', href: '/browse', label: t.browseTab },
  ];

  return (
    <nav className={styles.tabs} aria-label={t.recipesNav}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`${styles.tab} ${tab.key === current ? styles.active : ''}`}
          aria-current={tab.key === current ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
