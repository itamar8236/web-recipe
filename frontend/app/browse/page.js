'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import BrowseCard from '@/components/BrowseCard';
import ModeTabs from '@/components/ModeTabs';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './browse.module.css';

// Other users' public recipes, in a random order, a page at a time: the next page loads
// when the end of the list comes near the screen (and "Show more" does the same by hand).
function BrowseFeed() {
  const { t } = useLanguage();
  // null until the first load picks one, so nothing random runs while the page is built.
  const [seed, setSeed] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [next, setNext] = useState(undefined); // undefined = first page not loaded, null = no more
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const latest = useRef(0); // the newest request; an older one's answer is dropped
  const sentinel = useRef(null);

  const loadPage = useCallback(async (pageSeed, after) => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.getBrowse(pageSeed, after);
      if (request !== latest.current) return;
      setRecipes((list) =>
        after ? [...list, ...page.recipes.filter((recipe) => !list.some((shown) => shown.id === recipe.id))] : page.recipes,
      );
      setNext(page.next);
    } catch (err) {
      if (request === latest.current) setError(err);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  // A new order, from the top.
  const shuffle = useCallback(() => {
    const fresh = api.newBrowseSeed();
    setSeed(fresh);
    setRecipes([]);
    setNext(undefined);
    loadPage(fresh, null);
  }, [loadPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    shuffle();
  }, [shuffle]);

  const loadMore = useCallback(() => {
    if (!loading && next) loadPage(seed, next);
  }, [loading, next, seed, loadPage]);

  // Loads the next page a little before the end of the list is reached.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !next || loading || error) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: '600px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [next, loading, error, loadMore]);

  const firstLoad = next === undefined;

  return (
    <section className={styles.feed}>
      <div className={styles.titleRow}>
        <div>
          <h1 className={styles.title}>{t.browseTitle}</h1>
          <p className="hint">{t.browseHint}</p>
        </div>
        <button type="button" className={`button secondary ${styles.shuffle}`} disabled={loading} onClick={shuffle}>
          {t.shuffle}
        </button>
      </div>

      {firstLoad && loading && <p>{t.loading}</p>}

      {!firstLoad && recipes.length === 0 && !error && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t.browseEmpty}</p>
          <p>{t.browseEmptyHint}</p>
        </div>
      )}

      {recipes.length > 0 && (
        <ul className={styles.list}>
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <BrowseCard recipe={recipe} />
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className={styles.empty} role="alert">
          <p className={styles.emptyTitle}>{t.errBrowseLoad}</p>
          <p>{errorMessage(t, error)}</p>
          <button type="button" className="button" onClick={() => (firstLoad ? shuffle() : loadPage(seed, next))}>
            {t.retry}
          </button>
        </div>
      )}

      {!firstLoad && !error && next && (
        <div ref={sentinel} className={styles.more}>
          <button type="button" className="button secondary" disabled={loading} onClick={loadMore}>
            {loading ? t.loading : t.loadMore}
          </button>
        </div>
      )}

      {!firstLoad && !error && next === null && recipes.length > 0 && (
        <p className={`hint ${styles.end}`}>{t.browseEnd}</p>
      )}
    </section>
  );
}

export default function BrowsePage() {
  const { t } = useLanguage();
  const { status } = useAuth();

  // Browsing reads the database, so it needs an account: a guest is told so.
  if (status !== 'user') {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>{t.errBrowseNeedsLogin}</p>
        <Link href="/" className="button secondary">{t.back}</Link>
      </div>
    );
  }

  return (
    <>
      <ModeTabs current="browse" />
      <BrowseFeed />
    </>
  );
}
