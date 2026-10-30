import { defaultLocale, ui, type Locale, type UIKey } from './ui';

/** Falls back to the default locale so a missing string renders copy, not a key. */
export function useTranslations(locale: Locale) {
  return function t(key: UIKey): string {
    return ui[locale][key] ?? ui[defaultLocale][key];
  };
}

/**
 * Build a path within a locale: the default locale is unprefixed (`/`), the
 * others are prefixed (`/tr/`). Trailing slashes match Astro's directory URLs,
 * which avoids a redirect hop on Cloudflare Pages.
 */
export function localizePath(path: string, locale: Locale): string {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return clean === '' ? `${prefix}/` : `${prefix}/${clean}/`;
}
