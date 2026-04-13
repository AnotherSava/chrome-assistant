Read `~/.claude/learnings/chrome-extension.md` for domain-specific patterns. When you discover new Chrome extension gotchas, API quirks, or non-obvious behaviors during this project, update that file with the new finding.

## Architecture

Monorepo for a family of Chrome extensions that share a common side panel framework. Each site (Gmail, BGA, etc.) is built as an independent extension with its own manifest, permissions, and Chrome Web Store listing. A future hub extension can coordinate installed site extensions via `chrome.runtime.sendMessage` / `externally_connectable`.

The reference implementation for shared/core functionality is the BGA extension repo ([BGA Assistant](https://github.com/AnotherSava/bga-assistant)). When implementing core features (side panel shell, messaging, settings, icons, toggles, zoom, pin mode, help, CSS), port the logic from the BGA extension rather than rewriting from scratch.

### Why separate extensions, not one super-extension

- Users install only the sites they need — no bloat
- Each extension requests only its own host permissions
- Updates are scoped — a BGA change doesn't push an update to Gmail users
- Chrome Web Store listings are focused and discoverable

### Monorepo Layout

```
packages/
  core/             # shared side panel shell, settings, icons, toggles, messaging, CSS
  site-gmail/       # Gmail extension (standalone)
  site-bga/         # BGA extension (future — migrate from [BGA Assistant](https://github.com/AnotherSava/bga-assistant))
  hub/              # coordinator extension (future — unified icon, discovers installed sites)
docs/               # GitHub Pages documentation site (shared across all extensions)
  index.md
  pages/
    gmail/          # Gmail extension docs
    bga/            # BGA extension docs (future)
```

Each `packages/site-*/` is a buildable extension that bundles `core/` at build time — no runtime dependency between extensions. The hub is optional; site extensions work standalone.

### Site Interface

Each site package imports core and implements a common interface so the shared side panel can drive it without site-specific knowledge. Sites provide: URL pattern, extraction logic, rendering, and optional custom CSS/toggles.

### Future: BGA Migration

The BGA extension ([BGA Assistant](https://github.com/AnotherSava/bga-assistant)) will eventually move into `packages/site-bga/`. Both projects should maintain structural alignment to make the migration mechanical: same build tooling, entry point patterns, messaging protocol, and shared core interface.

## TypeScript Conventions

This is a TypeScript Chrome extension project. Build with Vite, test with vitest.

Use explicit type annotations on function parameters and return values. Use modern union syntax (`string | null`) — not utility types where a union suffices.

Do not break long single-expression lines (template literals, chained calls, etc.) into multiple lines for formatting. Keep them on one line.

Avoid cryptic abbreviations in variable and attribute names. Use descriptive names.

## Workflow

Run `npm run build` after each batch of changes so the extension can be reloaded and tested in the browser.

## Commands

- `npm run build` — build the extension to dist/
- `npm test` — run all tests
- `npm run lint` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — watch mode build
- `npm run package` — build and create Chrome Web Store ZIP

## Project Structure

- `vite.config.ts` — root Vite/vitest config (test environment, `@core` alias for tests, coverage settings)
- `vite.config.base.ts` — shared Vite build config (output naming, `@core` alias, icon copy plugin)
- `scripts/package.ts` — Chrome Web Store ZIP packaging script
- `packages/core/tests/` — unit tests for core modules (icons, settings)
- `packages/core/src/settings.ts` — shared chrome.storage.local persistence (async loadSettings batch loader, saveSetting, onSettingChanged listener with typed defaults)
- `packages/core/src/icons.ts` — shared SVG icon constants and escapeHtml utility
- `packages/core/src/types.ts` — shared TypeScript types (PinMode, GmailLabel, CacheMessage)
- `packages/core/src/sidepanel.css` — shared side panel styles (dark theme, top bar, labels, help, zoom)
- `packages/site-gmail/` — Gmail extension package
- `packages/site-gmail/manifest.json` — Gmail extension manifest
- `packages/site-gmail/sidepanel.html` — side panel HTML entry point
- `packages/site-gmail/vite.config.ts` — Gmail-specific Vite config (extends base, sets entry points)
- `packages/site-gmail/src/background.ts` — service worker (port-based messaging, orchestrator integration via start()/setFilterConfig(), selectionChanged handler with Gmail navigation + setFilterConfig, result callback relay as filterResults to sidepanel, cacheState push to sidepanel, resetCache handler, return-to-inbox on disconnect, user-navigation detection for auto-tab-switch, chrome.storage.onChanged listener for shared settings)
- `packages/site-gmail/src/sidepanel.ts` — side panel shell (connection, tab switching, zoom, pin mode, display settings panel with chrome.storage.local persistence, cache reset button, help, handleMessage dispatch)
- `packages/site-gmail/src/search-tab.ts` — Search tab (label tree building, rendering, filtering, selection, scope, cache progress, co-label counts, sends selectionChanged to service worker)
- `packages/site-gmail/src/gmail-api.ts` — Gmail API client (OAuth2 auth, label fetch, per-page fetch variants for orchestrator pagination, scope-based message search with beforeDate support for parallel segments, search query builder)
- `packages/site-gmail/src/cache-db.ts` — IndexedDB storage layer (meta store for label indexes and fetch state, label coverage tracking)
- `packages/site-gmail/src/cache-manager.ts` — cache orchestrator (single-loop architecture with decide()/executeAction() and configurable concurrency, setFilterConfig() for priority control with push-based result callback, all-time per-label fetch with in-memory ID accumulation, co-label counts via label index intersection, incremental refresh, reset support)
- `packages/site-gmail/src/help.ts` — Gmail-specific help page renderer
- `assets/extension/gmail/` — Gmail extension icons

### Path Aliases

`@core` resolves to `packages/core/` and is configured in both `vite.config.base.ts` (for builds) and `vite.config.ts` (for tests). Site packages import shared code via `@core/settings.js`, `@core/icons.js`, etc.
