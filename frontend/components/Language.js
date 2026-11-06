'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { strings } from '@/lib/i18n';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState('en');

  // Read the saved choice after mount so the static page and the first render match.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lang');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === 'en' || saved === 'he') setLangState(saved);
    } catch {
      // Storage can be blocked; the default language is fine.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  }, [lang]);

  function setLang(next) {
    setLangState(next);
    try {
      localStorage.setItem('lang', next);
    } catch {
      // Not remembering the choice is harmless.
    }
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: strings[lang] }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
