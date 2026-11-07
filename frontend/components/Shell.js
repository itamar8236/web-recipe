'use client';

import { AuthProvider, useAuth } from './Auth';
import { LanguageProvider, useLanguage } from './Language';
import Header from './Header';
import LoginScreen from './LoginScreen';
import styles from './Shell.module.css';

// Shows the app to a logged-in user or a guest, and the login screen to everyone else.
// The login screen replaces the page in place (no /login route), so after logging in the
// user is already on the page they opened.
function Page({ children }) {
  const { t } = useLanguage();
  const { status } = useAuth();

  return (
    <>
      <Header />
      <main className={styles.main}>
        {status === 'loading' && <p>{t.loading}</p>}
        {status === 'anonymous' && <LoginScreen />}
        {(status === 'user' || status === 'guest') && children}
      </main>
    </>
  );
}

export default function Shell({ children }) {
  return (
    <LanguageProvider>
      <AuthProvider>
        <Page>{children}</Page>
      </AuthProvider>
    </LanguageProvider>
  );
}
