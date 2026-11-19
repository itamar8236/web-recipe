'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import ConfirmDialog from './ConfirmDialog';
import SubstituteDialog from './SubstituteDialog';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './RecipeAiTools.module.css';

const hasText = (content) => Boolean(content.name || content.ingredients.length || content.steps.length);

// The "AI tools" box at the bottom of a saved recipe's page, for a logged-in user. Every
// tool is shown at once, as one big button each, so there is nothing to discover:
// - translate the language shown into the other one, or, when the app's language has no
//   text yet, the other language into it;
// - calculate calories and protein per serving from the shown text;
// - substitute an ingredient: opens a dialog, and its answer is gone when it closes;
// - for an imported recipe, scan its link again, optionally with the best model.
// Translating and calculating save the recipe at once and hand the saved recipe to
// `onSaved`; a translation or an estimate that would replace something asks first. The
// backend picks the models.
export default function RecipeAiTools({ recipe, lang, onSaved }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [useBest, setUseBest] = useState(false);
  const [busy, setBusy] = useState(null); // null | 'translate' | 'nutrition' | 'rescan'
  const [confirming, setConfirming] = useState(null); // null | 'translate' | 'nutrition' | 'rescan'
  const [substituting, setSubstituting] = useState(false);
  const [error, setError] = useState('');

  const other = lang === 'en' ? 'he' : 'en';
  // The language whose text is shown on the page: the app's own, or the other when the
  // app's has none yet. Every tool reads that text.
  const shown = recipe[lang].name ? lang : other;
  const into = shown === 'en' ? 'he' : 'en';
  const content = recipe[shown];
  const hasIngredients = content.ingredients.length > 0;
  const hasNutrition = recipe.calories !== null || recipe.protein !== null;

  async function run(kind, action) {
    setConfirming(null);
    setError('');
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(null);
    }
  }

  const translate = () =>
    run('translate', async () => {
      const translated = await api.translateRecipe(shown, content, recipe.id);
      onSaved(await api.saveRecipe(recipe.id, { en: recipe.en, he: recipe.he, [into]: translated }));
    });

  const estimateNutrition = () =>
    run('nutrition', async () => {
      const nutrition = await api.estimateNutrition(content, recipe.id);
      onSaved(await api.saveRecipe(recipe.id, { en: recipe.en, he: recipe.he, ...nutrition }));
    });

  // Like a new import: it runs in the background and its card shows on Home.
  async function rescan() {
    setConfirming(null);
    setError('');
    setBusy('rescan');
    try {
      await api.rerunRecipe(recipe.id, useBest);
      router.push('/');
    } catch (err) {
      setError(errorMessage(t, err));
      setBusy(null);
    }
  }

  const confirmations = {
    translate: { message: t.confirmTranslate[into], label: t.translateShort, onConfirm: translate },
    nutrition: { message: t.confirmEstimateNutrition, label: t.estimateNutritionShort, onConfirm: estimateNutrition },
    rescan: { message: t.confirmRescan, label: t.rescanShort, onConfirm: rescan },
  };

  return (
    <section className={styles.tools} aria-labelledby="ai-tools-title">
      <h2 id="ai-tools-title" className={styles.title}>
        <span aria-hidden="true">✨</span> {t.aiTools}
      </h2>

      <div className={styles.buttons}>
        <button
          type="button"
          className={`button secondary ${styles.tool}`}
          disabled={busy !== null || !hasIngredients}
          onClick={() => setSubstituting(true)}
        >
          {t.substitute}
        </button>

        <button
          type="button"
          className={`button secondary ${styles.tool}`}
          disabled={busy !== null || !hasText(content)}
          onClick={() => (hasText(recipe[into]) ? setConfirming('translate') : translate())}
        >
          {busy === 'translate' ? t.translating : t.translateTo[into]}
        </button>

        <button
          type="button"
          className={`button secondary ${styles.tool}`}
          disabled={busy !== null || !hasIngredients}
          onClick={() => (hasNutrition ? setConfirming('nutrition') : estimateNutrition())}
        >
          {busy === 'nutrition' ? t.estimatingNutrition : t.estimateNutrition}
        </button>

        {recipe.link && (
          <div className={styles.rescan}>
            <button
              type="button"
              className={`button secondary ${styles.tool}`}
              disabled={busy !== null}
              onClick={() => setConfirming('rescan')}
            >
              {busy === 'rescan' ? t.importStarting : t.rescan}
            </button>
            <label className={styles.choice}>
              <input type="checkbox" checked={useBest} disabled={busy !== null} onChange={(event) => setUseBest(event.target.checked)} />
              {t.useBestModel}
            </label>
          </div>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {confirming && (
        <ConfirmDialog
          message={confirmations[confirming].message}
          confirmLabel={confirmations[confirming].label}
          danger={false}
          onConfirm={confirmations[confirming].onConfirm}
          onCancel={() => setConfirming(null)}
        />
      )}

      {substituting && (
        <SubstituteDialog recipeId={recipe.id} from={shown} ingredients={content.ingredients} onClose={() => setSubstituting(false)} />
      )}
    </section>
  );
}
