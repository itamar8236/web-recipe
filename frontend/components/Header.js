'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './Auth';
import { useLanguage } from './Language';
import AccountDialog from './AccountDialog';
import { LANGUAGES, languageLabels } from '@/lib/i18n';
import styles from './Header.module.css';

export default function Header() {
  const { lang, setLang, t } = useLanguage();
  const { status, user, logOut, leaveGuest } = useAuth();
  // While adding or editing a recipe the app language stays fixed; the form has its own
  // English/Hebrew tabs for the recipe text.
  const locked = usePathname().startsWith('/recipe/edit');
  const [accountOpen, setAccountOpen] = useState(false);

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
      {(status === 'user' || status === 'guest') && (
        <div className={styles.userBar}>
          {status === 'user' ? (
            <button
              type="button"
              className={styles.accountButton}
              title={t.myAccount}
              onClick={() => setAccountOpen(true)}
            >
              <svg className={styles.accountIcon} viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
              </svg>
              <span className={styles.userName}>{t.hello(user.username)}</span>
            </button>
          ) : (
            <span className={styles.userName}>{t.guest}</span>
          )}
          <button
            type="button"
            className={styles.userButton}
            onClick={status === 'user' ? logOut : leaveGuest}
          >
            {status === 'user' ? t.logOut : t.logIn}
          </button>
        </div>
      )}
      {accountOpen && status === 'user' && <AccountDialog onClose={() => setAccountOpen(false)} />}
    </header>
  );
}
