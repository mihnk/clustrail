# website

Source for [clustrail.mihnk.org](https://clustrail.mihnk.org), the Clustrail
product page. A static [Astro](https://astro.build) site in English (`/`) and
Turkish (`/tr/`); all copy lives in `src/i18n/ui.ts`. Fonts (Geist) are
bundled, so the page makes no third-party requests.

## development

Requires Node.js 22.

```sh
npm install
npm run dev
```

| Script                 | Description                   |
| ---------------------- | ----------------------------- |
| `npm run dev`          | Start the development server  |
| `npm run build`        | Build the site into `dist/`   |
| `npm run preview`      | Serve the built output        |
| `npm run typecheck`    | Typecheck with `astro check`  |
| `npm run format`       | Format with Prettier          |
| `npm run format:check` | Check formatting (used in CI) |

## deployment

Cloudflare Workers Builds deploys `dist/` as static assets (`wrangler.jsonc`,
no Worker code): pull requests get a preview, `main` goes to production.

| Setting         | Value                          |
| --------------- | ------------------------------ |
| Path            | `/website`                     |
| Build command   | `npm ci && npm run build`      |
| Deploy command  | `npx wrangler deploy`          |
| Preview command | `npx wrangler versions upload` |
| `NODE_VERSION`  | `22`                           |
| Custom domain   | `clustrail.mihnk.org`          |

The app icon and favicons come from `build/appicon.svg` and
`build/appicon-small.svg` in the repository root.
