import { createElement, Fragment, type ReactNode } from "react";
import { tr } from "./tr";

// UI translation. The English text is the key, so components stay readable and
// a missing translation shows the English original. Placeholders: {name}.
//
// The language is read once, when this module loads (before any component or
// module-level label is evaluated), from the same preference Settings writes.
// Changing it reloads the window; open tabs are restored on launch.

export type Language = "en" | "tr";
export type LanguageSetting = "system" | Language;

export const LANGUAGE_PREFERENCE = "settings.language";

const DICTIONARIES: Record<Language, Record<string, string> | null> = { en: null, tr };

/** The language a setting resolves to; "system" follows the OS (navigator.language). */
export function resolveLanguage(setting: LanguageSetting): Language {
  if (setting !== "system") return setting;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("tr") ? "tr" : "en";
}

function storedSetting(): LanguageSetting {
  try {
    const raw = localStorage.getItem(`clustrail.${LANGUAGE_PREFERENCE}`);
    const v = raw === null ? "system" : (JSON.parse(raw) as unknown);
    return v === "en" || v === "tr" ? v : "system";
  } catch {
    return "system";
  }
}

let current: Language = resolveLanguage(storedSetting());
if (typeof document !== "undefined") document.documentElement.lang = current;

export function language(): Language {
  return current;
}

/** BCP 47 locale for Intl formatting in the current language. */
export function locale(): string {
  return current === "tr" ? "tr-TR" : "en-US";
}

/** For tests: switch without reloading. */
export function setLanguage(lang: Language): void {
  current = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

/** Translates an English UI string; {placeholders} are filled from vars. */
export function t(text: string, vars?: Record<string, unknown>): string {
  const dict = DICTIONARIES[current];
  let out = (dict && dict[text]) || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/**
 * Like t(), but placeholders may be React nodes (a <code> span, a link):
 * returns the translated sentence with the nodes in the translation's order.
 */
export function tn(text: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = t(text).split(/\{(\w+)\}/);
  return createElement(
    Fragment,
    null,
    ...parts.map((p, i) => (i % 2 === 0 ? p : createElement(Fragment, { key: i }, p in vars ? vars[p] : `{${p}}`))),
  );
}

/** "5m ago" and "now" as the backend writes them, in the UI language. */
export function ago(text: string): string {
  if (text === "now") return t("now");
  const m = /^(.+) ago$/.exec(text);
  return m ? t("{age} ago", { age: m[1] }) : text;
}
