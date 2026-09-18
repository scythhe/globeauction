import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_LANG, dict, type Lang } from "./translations.ts";

const STORAGE_KEY = "globauction.lang";

function isLang(value: string | null): value is Lang {
  return value === "ka" || value === "en" || value === "ru";
}

// Module-level, not just component state: errorMessage() in AuthContext.tsx
// runs outside any component (inside a catch block), so it can't call a
// hook. Reading/writing this directly keeps that one non-component call
// site in sync with whatever the LanguageProvider below has active,
// without threading `lang` through every function that can throw.
let currentLang: Lang = readStoredLang();

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    // localStorage can throw in a private tab or with site data blocked —
    // fall back to the default rather than crashing the whole app over a
    // language preference.
    return DEFAULT_LANG;
  }
}

export function getCurrentLang(): Lang {
  return currentLang;
}

// Simple {placeholder} substitution — this app's strings only ever need
// one or two plain values dropped in (a price, a count, a countdown of
// seconds), never plural-aware grammar, so a full i18n library's
// pluralization rules would be unused mechanism, not missing coverage.
export function translate(key: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = dict[key];
  if (!entry) {
    console.warn(`i18n: missing key "${key}"`);
    return key;
  }
  let text = entry[lang];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

interface LanguageState {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  useEffect(() => {
    currentLang = lang;
    // Accessibility/SEO correctness — screen readers and search engines
    // read this attribute, not the rendered text, to know what language
    // the page is in.
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // per-viewer convenience only — losing the persisted choice just
      // means it resets to Georgian next visit, not a functional break.
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, lang, params),
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>
  );
}

export function useTranslation(): LanguageState {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useTranslation must be used inside LanguageProvider");
  return ctx;
}

export { LANGUAGES } from "./translations.ts";
export type { Lang } from "./translations.ts";
