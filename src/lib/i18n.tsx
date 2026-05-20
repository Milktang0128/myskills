/**
 * Tiny i18n layer — no external dep.
 *
 * Locale storage key: `myskills.locale` in localStorage. If missing, we
 * default to **zh** (the primary user is Chinese-speaking; SPEC and chat are
 * in Chinese). User can flip via the EN/中 toggle in the sidebar footer.
 *
 * Static-export caveat: the very first render on `file://` happens before
 * localStorage is read (the provider mounts a client effect to hydrate it),
 * so for one tick the UI shows the SSR-time default. That's fine for a desktop
 * app — the flash is invisible because Electron preloads the window hidden.
 *
 * Adding a string: add the key to BOTH `en` and `zh` dictionaries below. The
 * `Dict` type is derived from `en`, so TypeScript will scream if zh is missing
 * a key. Use `{{name}}` style placeholders for interpolation.
 */
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { en } from './locales/en';
import { zh } from './locales/zh';

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'myskills.locale';
const DEFAULT_LOCALE: Locale = 'zh';

export type TKey = keyof typeof en;
/** Locale dictionary: a `string` value for every key in `en`. Using `string`
 *  rather than `typeof en[TKey]` so the Chinese values aren't constrained to
 *  the literal English strings. The `Dict` type still enforces total coverage:
 *  if `zh` (typed as `Dict`) is missing a key, TypeScript will flag it. */
export type Dict = Record<TKey, string>;

const DICTS: Record<Locale, Dict> = { en: en as Dict, zh };

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? `{{${k}}}` : String(v);
  });
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'zh') {
        setLocaleState(stored);
      }
    } catch {
      // ignore — localStorage may be unavailable in some sandboxes
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // ignore
    }
    try {
      document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    } catch {
      // SSR
    }
  }, []);

  // Keep <html lang> in sync on first hydration too.
  useEffect(() => {
    try {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    } catch {
      // ignore
    }
  }, [locale]);

  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>): string => {
      const dict = DICTS[locale];
      const fallback = DICTS.en;
      const raw = dict[key] ?? fallback[key] ?? String(key);
      return interpolate(raw, vars);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Allow non-wrapped callers (e.g. tests, isolated renders) to still render.
    // They get English with no setter wired up.
    const enDict = en as Dict;
    return {
      locale: 'en',
      setLocale: () => {},
      t: (key, vars) => interpolate(enDict[key] ?? String(key), vars),
    };
  }
  return ctx;
}

/** Convenience hook for components that only need `t`. */
export function useT() {
  return useI18n().t;
}
