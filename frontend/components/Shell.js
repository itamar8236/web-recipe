'use client';

import { AuthProvider, useAuth } from './Auth';
import { LanguageProvider, useLanguage } from './Language';
import Header from './Header';
import LoginScreen from './LoginScreen';
import { errorMessage } from '@/lib/i18n';
import styles from './Shell.module.css';

// Shows the app to a logged-in user or a guest, and the login screen to everyone else.
// The login screen replaces the page in place (no /login route), so after logging in the
// user is already on the page they opened.
function Page({ children }) {
  const { t } = useLanguage();
  const { status, error, retry, continueAsGuest } = useAuth();

  return (
    <>
      <Header />
      <main className={styles.main}>
        {status === 'loading' && <p>{t.loading}</p>}
        {/* The login check failed (offline, or a server error), which says nothing about
            being logged out, so this asks to try again rather than showing the login
            screen. Guest mode stays offered, since `next dev` alone has no backend. */}
        {status === 'error' && (
          <div className={styles.checkFailed} role="alert">
            <p className={styles.checkFailedTitle}>{t.errCheckLogin}</p>
            <p>{errorMessage(t, error)}</p>
            <button type="button" className="button" onClick={retry}>
              {t.retry}
            </button>
            <button type="button" className="button secondary" onClick={continueAsGuest}>
              {t.continueAsGuest}
            </button>
            <p className="hint">{t.guestNote}</p>
          </div>
        )}
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
