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
4. The Another Assistant for Gmail icon appears in the Chrome toolbar

The extension's ID is pinned to the Chrome Web Store-published ID (`hmkfblmfbeakcddfocbnochpmbaiaakl`) via the `"key"` field in `packages/site-gmail/manifest.json`. Every unpacked install on every machine produces this same ID, matching the OAuth client registered in Google Cloud Console — so OAuth works for both unpacked dev builds and CWS-installed end users with no per-machine setup.

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
    manifest.json                 Gmail extension manifest (v3, side panel, OAuth2, "key" for pinned ID)
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

## OAuth setup

The Gmail extension uses `chrome.identity.getAuthToken()` against an OAuth 2.0 Chrome Extension client registered in Google Cloud Console. The client is bound to a single **Item ID**, which must match the extension ID Chrome assigns at runtime.

**For contributors using the committed OAuth client:** No setup required. The `"key"` field pins your unpacked ID to the published CWS ID, which matches the registered Item ID.

**For forks using their own OAuth client:**

1. Remove the `"key"` field from `manifest.json` so your unpacked install gets a unique ID.
2. Read that ID from `chrome://extensions`.
3. In Google Cloud Console, create a Chrome Extension OAuth client with that string as the **Item ID**.
4. Replace `manifest.json`'s `oauth2.client_id` with your new client_id.

**Troubleshooting `bad client id`:** If OAuth fails with `OAuth2 request failed: Service responded with error: 'bad client id: …'`, the extension's runtime ID (`chrome://extensions`) doesn't match the **Item ID** in the OAuth client at <https://console.cloud.google.com/auth/clients>. Update either side to reconcile. After Cloud Console edits, wait 5–60 min for propagation, then from the service worker's devtools console run `chrome.identity.clearAllCachedAuthTokens(() => {})` and fully quit/reopen Chrome.

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
