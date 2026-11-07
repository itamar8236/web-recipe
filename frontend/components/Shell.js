'use client';

import { LanguageProvider } from './Language';
import Header from './Header';
import styles from './Shell.module.css';

function Page({ children }) {
  return (
    <>
      <Header />
      <main className={styles.main}>{children}</main>
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
