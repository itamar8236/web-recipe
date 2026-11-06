'use client';

import Link from 'next/link';
import { useLanguage } from './Language';
import { pickLanguage } from '@/lib/i18n';
import styles from './RecipeCard.module.css';

export default function RecipeCard({ recipe, folderName }) {
  const { lang, t } = useLanguage();
  const content = pickLanguage(recipe, lang);

  return (
    <Link href={`/recipe?id=${recipe.id}`} className={styles.card}>
      <h2 className={styles.name}>{content.name}</h2>
      <p className={styles.meta}>
        {folderName && <span className={styles.folder}>{folderName}</span>}
        <span>{t.ingredients}: {content.ingredients.length}</span>
      </p>
    </Link>
  );
}
