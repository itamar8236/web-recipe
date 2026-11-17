'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import { findSharedLink } from '@/lib/share';
import * as api from '@/lib/api';
import styles from './share.module.css';

// How long "Importing" stays on screen before the app closes itself, so the user sees
// that the share worked.
const CLOSE_AFTER_MS = 1500;

// Closing the app returns Android to the app the user shared from. A page may close its
// window when it is the window's only history entry, which is how a share opens it.
function closeApp(onRefused) {
  window.close();
  // Still here: the browser refused (e.g. the app was already open on other pages).
  setTimeout(onRefused, 300);
}

// Opened by Android's Share menu (`share_target` in app/manifest.js) with the shared text
// in the query. Starts the import and then closes the app, which returns the user to the
// app they shared from, like sharing to a chat app. The import goes on in the background
// and shows as a card on Home.
function ShareImport() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useSearchParams();
  // Read once: the query is cleared below so that reopening this page never imports twice.
  const [link] = useState(() =>
    findSharedLink({ title: params.get('title'), text: params.get('text'), url: params.get('url') }),
  );
  const [state, setState] = useState(link ? 'starting' : 'nolink'); // starting | started | failed | nolink
  const [error, setError] = useState(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const started = useRef(false);

  function goBack() {
    closeApp(() => setCloseFailed(true));
  }

  useEffect(() => {
    if (started.current || !link) return;
    started.current = true;
    window.history.replaceState(null, '', '/share');
    api
      .startImport(link)
      .then(() => setState('started'))
      .catch((err) => {
        setError(err);
        setState('failed');
      });
  }, [link]);

  useEffect(() => {
    if (state !== 'started') return undefined;
    const timer = setTimeout(() => closeApp(() => setCloseFailed(true)), CLOSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <section className={styles.box} aria-live="polite">
      <h1 className={styles.title}>{t.shareTitle}</h1>
      {link && <p className={styles.link} dir="ltr">{link}</p>}

      {state === 'starting' && <p>{t.shareStarting}</p>}
      {state === 'started' && <p className={styles.ok}>{t.shareStarted}</p>}
      {state === 'nolink' && <p className="error" role="alert">{t.shareNoLink}</p>}
      {state === 'failed' && <p className="error" role="alert">{errorMessage(t, error)}</p>}

      {state !== 'starting' && (
        <div className={styles.actions}>
          <button type="button" className="button" onClick={goBack}>
            {t.shareGoBack}
          </button>
          <button type="button" className="button secondary" onClick={() => router.replace('/')}>
            {t.shareOpenRecipes}
          </button>
        </div>
      )}
      {closeFailed && <p className="hint">{t.shareUseBackButton}</p>}
    </section>
  );
}

export default function SharePage() {
  return (
    <Suspense>
      <ShareImport />
    </Suspense>
  );
}
