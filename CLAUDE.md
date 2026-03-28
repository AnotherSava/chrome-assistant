Read `~/.claude/learnings/chrome-extension.md` for domain-specific patterns. When you discover new Chrome extension gotchas, API quirks, or non-obvious behaviors during this project, update that file with the new finding.

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
- `npm run package` — build and create Chrome Web Store ZIP (gmail-assistant-{version}.zip)

## Project Structure

- `src/background.ts` — service worker
- `assets/extension/` — extension icons
