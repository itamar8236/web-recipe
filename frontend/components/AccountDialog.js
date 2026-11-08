'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from './Auth';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import { errorMessage } from '@/lib/i18n';
import styles from './AccountDialog.module.css';

// "My account": change the username and/or the password, confirmed with an "are you sure?"
// box. The old password isn't asked for (the owner's choice: the session already proves
// who this is).
export default function AccountDialog({ onClose }) {
  const { t } = useLanguage();
  const { user, updateAccount } = useAuth();
  const ref = useRef(null);
  const [username, setUsername] = useState(user.username);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current.showModal();
  }, []);

  // Only what changed is sent, so saving just a new name keeps the password as is.
  function changes() {
    const result = {};
    if (username.trim() !== user.username) result.username = username.trim();
    if (password) result.password = password;
    return result;
  }

  function submit(event) {
    event.preventDefault();
    const nothingChanged = Object.keys(changes()).length === 0;
    setError(nothingChanged ? t.noChanges : '');
    setConfirming(!nothingChanged);
  }

  async function save() {
    setConfirming(false);
    setBusy(true);
    try {
      await updateAccount(changes());
      onClose();
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="account-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="account-title" className={styles.title}>
        {t.myAccount}
      </h2>
      <form className={styles.form} onSubmit={submit}>
        <div>
          <label className="label" htmlFor="account-username">
            {t.username}
          </label>
          <input
            id="account-username"
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
          <label className="label" htmlFor="account-password">
            {t.newPassword}
          </label>
          <input
            id="account-password"
            type="password"
            className="field"
            value={password}
            maxLength={200}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="hint">{t.newPasswordHint}</p>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <button type="submit" className="button" disabled={busy}>
            {busy ? t.saving : t.save}
          </button>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </form>

      {confirming && (
        <ConfirmDialog
          message={t.confirmSaveAccount}
          confirmLabel={t.save}
          danger={false}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        />
      )}
    </dialog>
  );
}
