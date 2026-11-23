'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import { findSharedLink, takeSharedPhotos } from '@/lib/share';
import { importPhotos } from '@/lib/photo';
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

// Waits for the recipe's picture too, since closing the app would stop sending it. No
// photos left (the page was opened again) is the same as nothing shared.
async function startSharedPhotos() {
  const photos = await takeSharedPhotos();
  if (!photos.length) return 'nolink';
  const { pictures } = await importPhotos(photos);
  await pictures;
  return 'started';
}

// Opened by Android's Share menu (`share_target` in app/manifest.js, through public/sw.js)
// with the shared text in the query, or with `photos=<count>` when photos were shared from
// the gallery (sw.js keeps them for takeSharedPhotos). Starts the import and then closes
// the app, which returns the user to the app they shared from, like sharing to a chat app. The import goes on in the background
// and shows as a card on Home.
function ShareImport() {
  const { t } = useLanguage();
  const router = useRouter();
  const params = useSearchParams();
  // Read once: the query is cleared below so that reopening this page never imports twice.
  const [link] = useState(() =>
    findSharedLink({ title: params.get('title'), text: params.get('text'), url: params.get('url') }),
  );
  const [photoCount] = useState(() => (link ? 0 : Number(params.get('photos')) || 0));
  const [state, setState] = useState(link || photoCount ? 'starting' : 'nolink'); // starting | started | failed | nolink
  const [error, setError] = useState(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const started = useRef(false);

  function goBack() {
    closeApp(() => setCloseFailed(true));
  }

  useEffect(() => {
    if (started.current || !(link || photoCount)) return;
    started.current = true;
    window.history.replaceState(null, '', '/share');
    (link ? api.startImport(link).then(() => 'started') : startSharedPhotos())
      .then(setState)
      .catch((err) => {
        setError(err);
        setState('failed');
      });
  }, [link, photoCount]);

  useEffect(() => {
    if (state !== 'started') return undefined;
    const timer = setTimeout(() => closeApp(() => setCloseFailed(true)), CLOSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <section className={styles.box} aria-live="polite">
      <h1 className={styles.title}>{t.shareTitle}</h1>
      {link && <p className={styles.link} dir="ltr">{link}</p>}

      {photoCount > 0 && state !== 'nolink' && <p className={styles.link}>{t.sharePhotos(photoCount)}</p>}

      {state === 'starting' && <p>{photoCount ? t.shareSendingPhotos : t.shareStarting}</p>}
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
