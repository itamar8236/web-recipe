'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import BackLink from '@/components/BackLink';
import BrowseCard from '@/components/BrowseCard';
import ModeTabs from '@/components/ModeTabs';
import SearchBox from '@/components/SearchBox';
import SortMenu from '@/components/SortMenu';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import { matchesSearch } from '@/lib/search';
import * as api from '@/lib/api';
import styles from './browse.module.css';

// Other users' public recipes, in a random order (or the one picked in the sort menu), a page at a time: the next page loads
// when the end of the list comes near the screen (and "Show more" does the same by hand).
// Search filters the loaded recipes; while few match, the end stays near the screen, so
// more pages keep loading until enough match or there are no more.
function BrowseFeed() {
  const { t } = useLanguage();
  // null until the first load picks one, so nothing random runs while the page is built.
  const [seed, setSeed] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [next, setNext] = useState(undefined); // undefined = first page not loaded, null = no more
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('random');
  const latest = useRef(0); // the newest request; an older one's answer is dropped
  const sentinel = useRef(null);

  const loadPage = useCallback(async (pageSeed, after, pageSort) => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.getBrowse(pageSeed, after, pageSort);
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

  // From the top, in `startSort` (a new random order for 'random').
  const start = useCallback(
    (startSort) => {
      const fresh = api.newBrowseSeed();
      setSeed(fresh);
      setRecipes([]);
      setNext(undefined);
      loadPage(fresh, null, startSort);
    },
    [loadPage],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    start('random');
  }, [start]);

  const changeSort = (value) => {
    setSort(value);
    start(value);
  };

  const loadMore = useCallback(() => {
    if (!loading && next) loadPage(seed, next, sort);
  }, [loading, next, seed, sort, loadPage]);

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
  const searching = query.trim() !== '';
  const visible = recipes.filter((recipe) => matchesSearch(recipe, query, recipe.tags));

  return (
    <section className={styles.feed}>
      <div className={styles.tools}>
        <SearchBox value={query} onChange={setQuery} />
        <SortMenu value={sort} onChange={changeSort} first="random" />
      </div>
      <h1 className={styles.title}>{t.browseTitle}</h1>

      {firstLoad && loading && <p>{t.loading}</p>}

      {!firstLoad && recipes.length === 0 && next === null && !error && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t.browseEmpty}</p>
          <p>{t.browseEmptyHint}</p>
        </div>
      )}

      {searching && recipes.length > 0 && visible.length === 0 && next === null && !error && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t.emptySearch}</p>
          <p>{t.emptySearchHint}</p>
        </div>
      )}

      {visible.length > 0 && (
        <ul className={styles.list}>
          {visible.map((recipe) => (
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
          <button type="button" className="button" onClick={() => (firstLoad ? start(sort) : loadPage(seed, next, sort))}>
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

      {!firstLoad && !error && next === null && visible.length > 0 && (
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
        <BackLink className="button secondary">{t.back}</BackLink>
      </div>
    );
  }

  return (
    <ModeTabs current="browse">
      <BrowseFeed />
    </ModeTabs>
  );
}
