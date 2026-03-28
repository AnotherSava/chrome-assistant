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

- `packages/core/settings.ts` — shared localStorage persistence (loadSetting/saveSetting with typed defaults)
- `packages/core/icons.ts` — shared SVG icon constants and escapeHtml utility
- `packages/core/toggle.ts` — shared tooltip positioning and visibility toggle helpers
- `packages/site-gmail/` — Gmail extension package
- `packages/site-gmail/src/background.ts` — service worker
- `packages/site-gmail/manifest.json` — Gmail extension manifest
- `packages/site-gmail/sidepanel.html` — side panel HTML entry point
- `assets/extension/gmail/` — Gmail extension icons
- `docs/` — GitHub Pages documentation site
