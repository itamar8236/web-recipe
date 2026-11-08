'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import FolderBar from '@/components/FolderBar';
import ImportCards, { useImports } from '@/components/ImportCards';
import ImportDialog from '@/components/ImportDialog';
import RecipeCard from '@/components/RecipeCard';
import SearchBox from '@/components/SearchBox';
import { useAuth } from '@/components/Auth';
import { useLanguage } from '@/components/Language';
import { errorMessage } from '@/lib/i18n';
import { matchesSearch } from '@/lib/search';
import * as api from '@/lib/api';
import styles from './page.module.css';

export default function HomePage() {
  const { t } = useLanguage();
  const [folders, setFolders] = useState(null); // null while loading
  const [recipes, setRecipes] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [savingFavorite, setSavingFavorite] = useState(new Set()); // recipe ids
  const [selected, setSelected] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  // Importing needs an account, so a guest goes straight to the manual form.
  const canImport = useAuth().status === 'user';

  const reloadRecipes = useCallback(() => {
    api.getRecipes().then(setRecipes).catch(() => {});
  }, []);
  const { imports, models, refresh, addImport, removeImport } = useImports(canImport, reloadRecipes);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [loadedFolders, loadedRecipes] = await Promise.all([api.getFolders(), api.getRecipes()]);
      setRecipes(loadedRecipes);
      setFolders(loadedFolders);
    } catch (error) {
      setLoadError(error);
    }
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
  if (!folders) return <p>{t.loading}</p>;

  const visible = recipes.filter((r) => {
    if (favoritesOnly && !r.favorite) return false;
    if (!matchesSearch(r, query)) return false;
    if (selected === 'all') return true;
    return r.folderId === (selected === 'none' ? null : selected);
  });
  // A message about a failed tap is stale once the user does something else.
  const select = (value) => {
    setActionError(null);
    setSelected(value);
  };
  const folderName = (id) => folders.find((f) => f.id === id)?.name;
  const viewTitle = selected === 'all' ? t.allRecipes : selected === 'none' ? t.noFolder : folderName(selected);
  const newRecipeHref = typeof selected === 'number' ? `/recipe/edit?folder=${selected}` : '/recipe/edit';
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
    <div className={styles.layout}>
      <aside className={styles.side}>
        <SearchBox value={query} onChange={setQuery} />
        <FolderBar
          folders={folders}
          recipes={recipes}
          selected={selected}
          onSelect={select}
          onCreate={async (name) => {
            const folder = await api.createFolder(name);
            setFolders((list) => [...list, folder]);
            select(folder.id);
          }}
          onRename={async (id, name) => {
            const folder = await api.renameFolder(id, name);
            setFolders((list) => list.map((f) => (f.id === id ? folder : f)));
            setActionError(null);
          }}
          onDelete={async (id) => {
            await api.deleteFolder(id);
            setFolders((list) => list.filter((f) => f.id !== id));
            select('all');
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

        {canImport && <ImportCards imports={imports} models={models} refresh={refresh} removeImport={removeImport} />}

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
                  folderName={selected === 'all' ? folderName(recipe.folderId) : null}
                  saving={savingFavorite.has(recipe.id)}
                  onToggleFavorite={() => toggleFavorite(recipe)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {importOpen && (
        <ImportDialog
          models={models}
          manualHref={newRecipeHref}
          onModelsStale={refresh}
          onStarted={(started) => {
            addImport(started);
            setImportOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
