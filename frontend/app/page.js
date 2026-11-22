'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import ModeTabs from '@/components/ModeTabs';
import TagBar from '@/components/TagBar';
import ImportCards, { useImports } from '@/components/ImportCards';
import DeletedDialog from '@/components/DeletedDialog';
import ImportDialog from '@/components/ImportDialog';
import RecipeCard from '@/components/RecipeCard';
import SearchBox from '@/components/SearchBox';
import SortMenu from '@/components/SortMenu';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import { matchesSearch } from '@/lib/search';
import { sortRecipes } from '@/lib/sort';
import * as api from '@/lib/api';
import styles from './page.module.css';

export default function HomePage() {
  const { t } = useLanguage();
  const [tags, setTags] = useState(null); // null while loading
  const [recipes, setRecipes] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [savingFavorite, setSavingFavorite] = useState(new Set()); // recipe ids
  const [selected, setSelected] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [importOpen, setImportOpen] = useState(false);
  const [deleted, setDeleted] = useState([]); // "Recently deleted", for the link and its dialog
  const [deletedOpen, setDeletedOpen] = useState(false);
  // Importing needs an account, so a guest goes straight to the manual form.
  const canImport = useAuth().status === 'user';

  const reloadRecipes = useCallback(() => {
    api.getRecipes().then(setRecipes).catch(() => {});
  }, []);
  const { imports, backAt, refresh, addImport, dismissImport } = useImports(canImport, reloadRecipes);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [loadedTags, loadedRecipes] = await Promise.all([api.getTags(), api.getRecipes()]);
      setRecipes(loadedRecipes);
      setTags(loadedTags);
    } catch (error) {
      setLoadError(error);
    }
    // Only for the link at the bottom: if it fails, the link just doesn't show.
    api.getDeletedRecipes().then(setDeleted).catch(() => {});
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (loadError) {
    return (
      <div className={styles.empty} role="alert">
        <p className={styles.emptyTitle}>{t.errLoad}</p>
        <p>{errorMessage(t, loadError)}</p>
        <button type="button" className="button" onClick={load}>{t.retry}</button>
      </div>
    );
  }
  if (!tags) return <p>{t.loading}</p>;

  const tagName = (id) => tags.find((tag) => tag.id === id)?.name;
  const visible = sortRecipes(recipes, sort).filter((r) => {
    if (favoritesOnly && !r.favorite) return false;
    if (!matchesSearch(r, query, r.tagIds.map(tagName).filter(Boolean))) return false;
    if (selected === 'all') return true;
    return selected === 'none' ? r.tagIds.length === 0 : r.tagIds.includes(selected);
  });
  // A message about a failed tap is stale once the user does something else.
  const select = (value) => {
    setActionError(null);
    setSelected(value);
  };
  const viewTitle = selected === 'all' ? t.allRecipes : selected === 'none' ? t.noTags : tagName(selected);
  const newRecipeHref = '/recipe/edit';
  const [emptyTitle, emptyHint] = query.trim()
    ? [t.emptySearch, t.emptySearchHint]
    : favoritesOnly
      ? [t.emptyFavorites, t.emptyFavoritesHint]
      : [t.emptyRecipes, t.emptyHint];

  // The heart changes at once and changes back if saving fails, so a tap feels instant.
  async function toggleFavorite(recipe) {
    const favorite = !recipe.favorite;
    const setLocal = (value) =>
      setRecipes((list) => list.map((r) => (r.id === recipe.id ? { ...r, favorite: value } : r)));
    setActionError(null);
    setLocal(favorite);
    setSavingFavorite((ids) => new Set(ids).add(recipe.id));
    try {
      await api.setFavorite(recipe.id, favorite);
    } catch (error) {
      setLocal(!favorite);
      setActionError(errorMessage(t, error));
    } finally {
      setSavingFavorite((ids) => {
        const next = new Set(ids);
        next.delete(recipe.id);
        return next;
      });
    }
  }

  return (
    <ModeTabs current="mine" show={canImport}>
    <div className={styles.layout}>
      <aside className={styles.side}>
        <div className={styles.tools}>
          <SearchBox value={query} onChange={setQuery} />
          <SortMenu value={sort} onChange={setSort} />
        </div>
        <TagBar
          tags={tags}
          recipes={recipes}
          selected={selected}
          onSelect={select}
          onRename={async (id, name) => {
            const renamed = await api.renameTag(id, name);
            setTags((list) => list.map((tag) => (tag.id === id ? renamed : tag)));
            setActionError(null);
          }}
        />
      </aside>

      <section className={styles.content}>
        <div className={styles.toolbar}>
          {canImport ? (
            <button type="button" className={`button ${styles.add}`} onClick={() => setImportOpen(true)}>
              + {t.addRecipe}
            </button>
          ) : (
            <Link href={newRecipeHref} className={`button ${styles.add}`}>
              + {t.addRecipe}
            </Link>
          )}
        </div>

        {canImport && (
          <ImportCards imports={imports} backAt={backAt} refresh={refresh} addImport={addImport} dismissImport={dismissImport} />
        )}

        <div className={styles.titleRow}>
          <div className={styles.titleText}>
            <h1 className={styles.title}>{viewTitle}</h1>
            <span className={styles.titleCount}>{t.recipeCount(visible.length)}</span>
          </div>

          <button
            type="button"
            className={`button secondary ${styles.favToggle} ${favoritesOnly ? styles.favOn : ''}`}
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly(!favoritesOnly)}
          >
            {t.favoritesOnly} {favoritesOnly ? '♥' : '♡'}
          </button>
        </div>

        {actionError && <p className="error" role="alert">{actionError}</p>}

        {visible.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{emptyTitle}</p>
            <p>{emptyHint}</p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {visible.map((recipe) => (
              <li key={recipe.id}>
                <RecipeCard
                  recipe={recipe}
                  tagNames={recipe.tagIds.map(tagName).filter(Boolean)}
                  saving={savingFavorite.has(recipe.id)}
                  onToggleFavorite={() => toggleFavorite(recipe)}
                />
              </li>
            ))}
          </ul>
        )}

        {deleted.length > 0 && (
          <button type="button" className={`button secondary ${styles.deletedLink}`} onClick={() => setDeletedOpen(true)}>
            🗑 {t.recentlyDeleted} ({deleted.length})
          </button>
        )}
      </section>

      {deletedOpen && (
        <DeletedDialog
          recipes={deleted}
          onClose={() => setDeletedOpen(false)}
          onRestored={(id, restored) => {
            setDeleted((list) => list.filter((r) => r.id !== id));
            setRecipes((list) => [...list, restored.recipe]);
            setTags(restored.tags);
          }}
        />
      )}

      {importOpen && (
        <ImportDialog
          backAt={backAt}
          manualHref={newRecipeHref}
          onClose={() => setImportOpen(false)}
          onModelsStale={refresh}
          onStarted={(started) => {
            addImport(started);
            setImportOpen(false);
            refresh();
          }}
        />
      )}
    </div>
    </ModeTabs>
  );
}
