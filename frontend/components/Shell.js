'use client';

import { LanguageProvider, useLanguage } from './Language';
import Header from './Header';
import styles from './Shell.module.css';

function Page({ children }) {
  const { t } = useLanguage();
  return (
    <>
      <Header />
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>{t.sessionNote}</footer>
    </>
  );
}

export default function Shell({ children }) {
  return (
    <LanguageProvider>
      <Page>{children}</Page>
    </LanguageProvider>
  );
}
