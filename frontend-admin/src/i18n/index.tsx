import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { Lang, LANGS, MessageKey, translate } from "./dictionary";

export type { Lang, MessageKey } from "./dictionary";
export { LANGS, translate } from "./dictionary";

/**
 * Tiny i18n for the public website (no library): Thai by default, English on request.
 * The choice is kept per browser and shared by every component through useSyncExternalStore.
 * The console stays Thai; only public-site chrome uses t().
 */
const STORAGE_KEY = "netprime.lang";
const EVENT = "netprime-lang-change";

function readLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LANGS as readonly string[]).includes(saved)) return saved as Lang;
  } catch { /* storage unavailable */ }
  return "th";
}

let current: Lang = typeof window === "undefined" ? "th" : readLang();

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) { current = readLang(); listener(); } };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", onStorage); };
}

export function getLang(): Lang { return current; }

export function setLang(lang: Lang) {
  if (!(LANGS as readonly string[]).includes(lang) || lang === current) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVENT));
}

/** Non-hook lookup in the current language (event handlers, helpers). */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(current, key, vars);
}

/** Current language + bound t(); components re-render when the language changes. */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang, () => "th" as Lang);
  const bound = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  return { lang, t: bound, setLang };
}

/** Keeps <html lang> in sync while the public site is shown. */
export function useDocumentLang() {
  const { lang } = useI18n();
  useEffect(() => {
    document.documentElement.lang = lang;
    return () => { document.documentElement.lang = "th"; };
  }, [lang]);
}

/** Picks the English variant of authored content when English is active and the variant exists. */
export function localized<T>(lang: Lang, th: T, en: T | null | undefined): T {
  return lang === "en" && en !== null && en !== undefined && en !== "" ? en : th;
}

/** TH | EN toggle for the public header. */
export const LanguageSwitcher: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => {
  const { lang, t } = useI18n();
  return (
    <div className={className ?? "ps-lang"} role="group" aria-label={t("lang.switch")} style={style}>
      {LANGS.map(code => (
        <button key={code} type="button" lang={code} aria-pressed={lang === code} onClick={() => setLang(code)}
          title={translate(code, "lang.name")}>
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
};
