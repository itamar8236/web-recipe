'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from './Language';
import { LANGUAGES, languageLabels } from '@/lib/i18n';
import styles from './Header.module.css';

export default function Header() {
  const { lang, setLang, t } = useLanguage();
  // While adding or editing a recipe the app language stays fixed; the form has its own
  // English/Hebrew tabs for the recipe text.
  const locked = usePathname().startsWith('/recipe/edit');

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static export, no image optimizer */}
          <img src="/icons/icon-192.png" alt="" className={styles.logo} width="36" height="36" />
          {t.appName}
        </Link>
        <div
          className={`${styles.toggle} ${locked ? styles.locked : ''}`}
          role="group"
          aria-label={t.language}
          title={locked ? t.languageLocked : undefined}
        >
          {LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              className={code === lang ? styles.active : ''}
              aria-pressed={code === lang}
              disabled={locked}
              onClick={() => setLang(code)}
            >
              {languageLabels[code]}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
