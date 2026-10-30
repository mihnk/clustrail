// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://clustrail.mihnk.org',

  build: {
    // 'preserve' keeps the source layout, so `[locale]/404.astro` emits
    // `/tr/404.html`, which the asset server returns for `/tr/*` misses.
    format: 'preserve',
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'tr'],
    routing: {
      // English stays at `/`, Turkish gets the `/tr/` prefix.
      prefixDefaultLocale: false,
    },
  },

  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', tr: 'tr' },
      },
    }),
  ],
});
