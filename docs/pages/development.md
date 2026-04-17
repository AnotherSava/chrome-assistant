---
layout: default
title: Development
---

[Home](..) | [Gmail](gmail) | [Development](development)

---

## Setup

### Prerequisites

- Node.js 18+
- Chrome 134+

### Install

```
npm install
npm run build
```

### Load from source

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" (toggle in the top-right corner)
3. Click "Load unpacked" and select `packages/site-gmail/`
4. The Gmail Assistant icon appears in the Chrome toolbar

## Commands

- `npm run build` — production build for all sites
- `npm run build:gmail` — build the Gmail extension only
- `npm run dev` / `npm run dev:gmail` — watch mode
- `npm run lint` — TypeScript type checking (`tsc --noEmit`)
- `npm run test` — run all unit tests
- `npm run package` — build and create a Chrome Web Store ZIP

## Architecture

Monorepo for a family of Chrome extensions that share a common side panel framework. Each site (Gmail, future extensions) is built as an independent extension with its own manifest, permissions, and Chrome Web Store listing.

**Why separate extensions, not one super-extension:**

- Users install only the sites they need — no bloat
- Each extension requests only its own host permissions
- Updates are scoped — a change to one site doesn't push an update to users of another
- Chrome Web Store listings are focused and discoverable

## Project structure

```
vite.config.ts                    root Vite/vitest config (test env, @core alias, coverage)
vite.config.base.ts               shared build config (output naming, @core alias, icon copy plugin)
scripts/
  package.ts                      CLI: build + create Chrome Web Store ZIP
packages/
  core/
    src/
      settings.ts                 chrome.storage.local persistence (loadSettings / saveSetting / onSettingChanged)
      icons.ts                    shared SVG icon constants, escapeHtml
      types.ts                    shared TypeScript types (PinMode, GmailLabel, CacheMessage)
      sidepanel.css               shared side panel styles (dark theme, top bar, labels, help, zoom)
    tests/                        unit tests for core modules
  site-gmail/
    manifest.json                 Gmail extension manifest (v3, side panel, OAuth2)
    sidepanel.html                Side panel HTML entry point
    vite.config.ts                Gmail-specific Vite config
    src/
      background.ts               Service worker: port-based messaging, cache orchestration, Gmail navigation, settings reactivity
      sidepanel.ts                Side panel shell: connection, tab switching, zoom, pin mode, display settings, cache reset, help
      search-tab.ts               Search tab: label tree, rendering, filtering, selection, scope, co-label counts
      gmail-api.ts                Gmail API client: OAuth2, label fetch, message search, scope-based parallel fetch
      cache-db.ts                 IndexedDB storage: label indexes, fetch state, label coverage tracking
      cache-manager.ts            Cache orchestrator: single-loop with configurable concurrency, push-based results, all-time per-label fetch, co-label counts via index intersection
      help.ts                     Gmail-specific help page renderer
    tests/                        unit tests for Gmail modules
assets/
  extension/gmail/                Gmail extension icons
```

### Path aliases

`@core` resolves to `packages/core/` and is configured in both `vite.config.base.ts` (for builds) and `vite.config.ts` (for tests). Site packages import shared code via `@core/settings.js`, `@core/icons.js`, etc.

## Architecture reference

### Gmail

- [Data flow](gmail/data-flow) — message protocols, flows for filter change, display settings change, cache rebuild, user navigation
- [Storage layout](gmail/storage-layout) — chrome.storage.local, chrome.storage.session, IndexedDB, service worker in-memory state — where each piece of state lives and who reads/writes it

## Testing

Tests use vitest and run in a jsdom environment with `fake-indexeddb` and `chrome-types` shims.

```
npm test                        # Run all tests
npx vitest run --coverage       # Run with coverage report
```
