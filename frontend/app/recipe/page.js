'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '@/components/Language';
import HeartButton from '@/components/HeartButton';
import { pickLanguage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './recipe.module.css';

function RecipeView() {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const id = Number(useSearchParams().get('id'));
  const [recipe, setRecipe] = useState(undefined); // undefined = loading, null = missing
  const [folderName, setFolderName] = useState('');

  useEffect(() => {
    async function load() {
      const found = await api.getRecipe(id);
      setRecipe(found);
      if (found?.folderId) {
        const folders = await api.getFolders();
        setFolderName(folders.find((f) => f.id === found.folderId)?.name ?? '');
      }
    }
    load();
  }, [id]);

  if (recipe === undefined) return <p>{t.loading}</p>;
  if (recipe === null) {
    return (
      <>
        <p>{t.notFound}</p>
        <Link href="/" className="button secondary">{t.back}</Link>
      </>
    );
  }

  const content = pickLanguage(recipe, lang);
  // Recipe text may be in the other language than the UI, so set direction on the text itself.
  const contentLang = content.translated ? lang : lang === 'en' ? 'he' : 'en';
  const contentDir = contentLang === 'he' ? 'rtl' : 'ltr';

  async function remove() {
    if (!window.confirm(t.confirmDeleteRecipe)) return;
    await api.deleteRecipe(recipe.id);
    router.push('/');
  }

  return (
    <article className={styles.recipe}>
      <Link href="/" className={styles.back}>
        <span aria-hidden="true" className={styles.arrow}>←</span> {t.back}
      </Link>

      <header className={styles.head} lang={contentLang} dir={contentDir}>
        <h1 className={styles.title}>{content.name}</h1>
        {folderName && <span className={styles.folder}>{folderName}</span>}
        <p className={styles.sourceRow}>
          {t.sourceLink}:{' '}
          {recipe.link ? (
            <a href={recipe.link} target="_blank" rel="noopener noreferrer" className={styles.source}>
              {new URL(recipe.link).hostname}
            </a>
          ) : (
            <span>{t.manualSource}</span>
          )}
        </p>
      </header>

      {!content.translated && <p className={styles.notice}>{t.notTranslated}</p>}

      <section className={styles.card}>
        <h2>{t.ingredients}</h2>
        <ul className={styles.ingredients} lang={contentLang} dir={contentDir}>
          {content.ingredients.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </section>

      <section className={styles.card}>
        <h2>{t.instructions}</h2>
        <ol className={styles.steps} lang={contentLang} dir={contentDir}>
          {content.steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      </section>

      <div className={styles.actions}>
        <HeartButton
          active={recipe.favorite}
          onClick={async () => {
            await api.toggleFavorite(recipe.id);
            setRecipe(await api.getRecipe(recipe.id));
          }}
        />
        <Link href={`/recipe/edit?id=${recipe.id}`} className="button">{t.edit}</Link>
        <button type="button" className="button danger" onClick={remove}>{t.delete}</button>
      </div>
    </article>
  );
}

export default function RecipePage() {
  return (
    <Suspense fallback={null}>
      <RecipeView />
    </Suspense>
  );
}
