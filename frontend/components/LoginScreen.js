'use client';

import { useState } from 'react';
import { useAuth } from './Auth';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import styles from './LoginScreen.module.css';

export default function LoginScreen() {
  const { t } = useLanguage();
  const { logIn, signUp, continueAsGuest } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signingUp = mode === 'signup';

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await (signingUp ? signUp : logIn)(username.trim(), password);
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(signingUp ? 'login' : 'signup');
    setError('');
  }

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>{signingUp ? t.signUp : t.logIn}</h1>

      <form className={styles.form} onSubmit={submit}>
        <div>
          <label className="label" htmlFor="username">
            {t.username}
          </label>
          <input
            id="username"
            className="field"
            value={username}
            maxLength={50}
            autoComplete="username"
            autoCapitalize="none"
            required
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            {t.password}
          </label>
          <input
            id="password"
            type="password"
            className="field"
            value={password}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button" disabled={busy}>
          {signingUp ? t.signUp : t.logIn}
        </button>
      </form>

      <p className={styles.switch}>
        {signingUp ? t.haveAccount : t.noAccount}{' '}
        <button type="button" className={styles.link} onClick={switchMode}>
          {signingUp ? t.logIn : t.signUp}
        </button>
      </p>

      <div className={styles.guest}>
        <button type="button" className="button secondary" onClick={continueAsGuest}>
          {t.continueAsGuest}
        </button>
        <p className="hint">{t.guestNote}</p>
      </div>
    </div>
  );
}
