'use client';

import Link from 'next/link';
import { useLanguage } from './Language';
import { LANGUAGES, languageLabels } from '@/lib/i18n';
import styles from './Header.module.css';

export default function Header() {
  const { lang, setLang, t } = useLanguage();

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          <span aria-hidden="true">🍳</span> {t.appName}
        </Link>
        <div className={styles.toggle} role="group" aria-label={t.language}>
          {LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              lang={code}
              className={code === lang ? styles.active : ''}
              aria-pressed={code === lang}
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
