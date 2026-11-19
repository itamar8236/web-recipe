'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { errorMessage } from '@/lib/i18n';
import * as api from '@/lib/api';
import styles from './SubstituteDialog.module.css';

// "Substitute an ingredient": the user taps one of the recipe's ingredients and the model
// suggests what to use instead, in the app's language. The suggestions are never saved:
// they live only in this dialog and are gone when it closes. `from` is the language the
// `ingredients` are written in.
export default function SubstituteDialog({ recipeId, from, ingredients, onClose }) {
  const { lang, t } = useLanguage();
  const ref = useRef(null);
  const [chosen, setChosen] = useState(null); // the ingredient's index, once tapped
  const [substitutes, setSubstitutes] = useState(null); // null while choosing or waiting
  const [error, setError] = useState('');
  // A late answer for an ingredient the user moved on from (or after closing) is dropped.
  const asked = useRef(0);

  useEffect(() => {
    ref.current.showModal();
    return () => {
      asked.current += 1;
    };
  }, []);

  async function ask(index) {
    const request = ++asked.current;
    setChosen(index);
    setSubstitutes(null);
    setError('');
    try {
      const answer = await api.suggestSubstitutes(recipeId, from, index, lang);
      if (request === asked.current) setSubstitutes(answer);
    } catch (err) {
      if (request === asked.current) setError(errorMessage(t, err));
    }
  }

  function chooseAnother() {
    asked.current += 1;
    setChosen(null);
    setSubstitutes(null);
    setError('');
  }

  const dir = (language) => (language === 'he' ? 'rtl' : 'ltr');
  const waiting = chosen !== null && substitutes === null && !error;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="substitute-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="substitute-title" className={styles.title}>{t.substitute}</h2>

      {chosen === null && (
        <>
          <p className={styles.question}>{t.substituteChoose}</p>
          <ul className={styles.choices} lang={from} dir={dir(from)}>
            {ingredients.map((ingredient, index) => (
              <li key={index}>
                <button type="button" className={styles.choice} onClick={() => ask(index)}>{ingredient}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {chosen !== null && (
        <div role="status">
          {!error && <p className={styles.question}>{waiting ? t.substituteFinding : t.substituteResults}</p>}
          <p className={styles.item} lang={from} dir={dir(from)}>{ingredients[chosen]}</p>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {substitutes && (
        <div className={styles.answer}>
          {substitutes.length === 0 ? (
            <p>{t.substituteNone}</p>
          ) : (
            <ul className={styles.results}>
              {substitutes.map((substitute, index) => (
                <li key={index} className={styles.result}>
                  <strong>{substitute.name}</strong>
                  {substitute.amount && <span className={styles.amount}>{substitute.amount}</span>}
                  {substitute.note && <span className="hint">{substitute.note}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">{t.substituteAiNote}</p>
        </div>
      )}

      <div className={styles.actions}>
        {chosen !== null && (
          <button type="button" className="button secondary" onClick={chooseAnother}>{t.substituteAgain}</button>
        )}
        <button type="button" className="button secondary" onClick={onClose}>{t.close}</button>
      </div>
    </dialog>
  );
}

