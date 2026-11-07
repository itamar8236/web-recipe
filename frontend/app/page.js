'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import FolderBar from '@/components/FolderBar';
import RecipeCard from '@/components/RecipeCard';
import { useLanguage } from '@/components/Language';
import * as api from '@/lib/api';
import styles from './page.module.css';

export default function HomePage() {
  const { t } = useLanguage();
  const [folders, setFolders] = useState(null);
  const [recipes, setRecipes] = useState([]);
  const [selected, setSelected] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const load = useCallback(async () => {
    const [loadedFolders, loadedRecipes] = await Promise.all([api.getFolders(), api.getRecipes()]);
    setFolders(loadedFolders);
    setRecipes(loadedRecipes);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!folders) return <p>{t.loading}</p>;

  const visible = recipes.filter((r) => {
    if (favoritesOnly && !r.favorite) return false;
    if (selected === 'all') return true;
    return r.folderId === (selected === 'none' ? null : selected);
  });
  const folderName = (id) => folders.find((f) => f.id === id)?.name;
  const viewTitle = selected === 'all' ? t.allRecipes : selected === 'none' ? t.noFolder : folderName(selected);
  const newRecipeHref = typeof selected === 'number' ? `/recipe/edit?folder=${selected}` : '/recipe/edit';

  return (
    <div className={styles.layout}>
      <aside className={styles.side}>
        <FolderBar
          folders={folders}
          recipes={recipes}
          selected={selected}
          onSelect={setSelected}
          onCreate={async (name) => {
            const folder = await api.createFolder(name);
            await load();
            setSelected(folder.id);
          }}
          onRename={async (id, name) => {
            await api.renameFolder(id, name);
            await load();
          }}
          onDelete={async (id) => {
            await api.deleteFolder(id);
            await load();
            setSelected('all');
          }}
        />
      </aside>

      <section className={styles.content}>
        <div className={styles.toolbar}>
          <Link href={newRecipeHref} className={`button ${styles.add}`}>
            + {t.addRecipe}
          </Link>
        </div>

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

        {visible.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{favoritesOnly ? t.emptyFavorites : t.emptyRecipes}</p>
            <p>{favoritesOnly ? t.emptyFavoritesHint : t.emptyHint}</p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {visible.map((recipe) => (
              <li key={recipe.id}>
                <RecipeCard
                  recipe={recipe}
                  folderName={selected === 'all' ? folderName(recipe.folderId) : null}
                  onToggleFavorite={async () => {
                    await api.toggleFavorite(recipe.id);
                    await load();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
