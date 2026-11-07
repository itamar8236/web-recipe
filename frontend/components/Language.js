'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { strings } from '@/lib/i18n';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  // Always open in Hebrew: the choice is not remembered between visits.
  const [lang, setLang] = useState('he');

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  }, [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: strings[lang] }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
