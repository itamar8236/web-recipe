'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import * as api from '@/lib/api';
import { errorMessage } from '@/lib/i18n';
import styles from './AccountDialog.module.css';

// Admin only, in "My account": log in as another user with no password. From then on the
// device is that user for everything, until it logs out; the admin then logs in again as
// themself. The page reloads so every screen starts over as the new user.
export default function ImpersonateSection({ busy, setBusy }) {
  const { t } = useLanguage();
  const [users, setUsers] = useState(null);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api.getUsers().then(
      (list) => {
        setUsers(list);
        if (list.length > 0) setUserId(String(list[0].id));
      },
      (err) => setError(errorMessage(t, err)),
    );
  }, [t]);

  const chosen = users?.find((u) => String(u.id) === userId);

  async function impersonate() {
    setConfirming(false);
    setBusy(true);
    setError('');
    try {
      await api.impersonate(chosen.id);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload, so no screen keeps the admin's data
      window.location.assign('/');
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(false);
    }
  }

  // Nobody to log in as (or still loading, without an error): nothing to show.
  if (!error && !users?.length) return null;

  return (
    <section className={styles.impersonate} aria-labelledby="impersonate-title">
      <h3 id="impersonate-title" className="label">
        {t.impersonateTitle}
      </h3>
      {users?.length > 0 && (
        <>
          <select
            className="field"
            aria-label={t.username}
            value={userId}
            disabled={busy}
            onChange={(e) => setUserId(e.target.value)}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
          <p className="hint">{t.impersonateHint}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !chosen}
              onClick={() => setConfirming(true)}
            >
              {busy ? t.impersonating : t.impersonateButton}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirming && chosen && (
        <ConfirmDialog
          message={t.confirmImpersonate(chosen.username)}
          confirmLabel={t.impersonateButton}
          danger={false}
          onConfirm={impersonate}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
