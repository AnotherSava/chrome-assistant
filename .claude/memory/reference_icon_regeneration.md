---
name: icon-regeneration-workflow
description: "Re-render assets/extension/gmail/icon-{16,48,128}.png from icon.svg using @resvg/resvg-js; install with npm --no-save --force"
metadata: 
  node_type: memory
  type: reference
---

**Master source:** `assets/extension/gmail/icon.svg`.
**Output:** `assets/extension/gmail/icon-{16,48,128}.png`.

**Steps:**
1. Edit `icon.svg`.
2. One-off install (only needed if `node_modules/@resvg/resvg-js` is missing): `npm install --no-save --force @resvg/resvg-js`. The `--force` is required because the project's `node_modules` contains Linux-only deps (`@esbuild/linux-x64`, `@rollup/rollup-linux-x64-musl`) that block normal installs on win32 with `EBADPLATFORM`.
3. Render via inline node script:
   ```js
   const { Resvg } = require('@resvg/resvg-js');
   const fs = require('fs');
   const svg = fs.readFileSync('assets/extension/gmail/icon.svg', 'utf8');
   for (const size of [16, 48, 128]) {
     const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
     fs.writeFileSync('assets/extension/gmail/icon-' + size + '.png', r.render().asPng());
   }
   ```
4. `npm run build` copies the new PNGs into `dist/icons/`.

**Avoid Chrome MCP for SVG-to-PNG.** `mcp__chrome-devtools__list_pages` fails with "browser is already running for `~/.cache/chrome-devtools-mcp/chrome-profile`" if the user's Chrome is already open with the default profile. `@resvg/resvg-js` works regardless.

**Do NOT verify the resulting PNGs via the Read tool.** Reading the generated PNGs has historically triggered a persistent "API Error: 400 Could not process image" that forces `/clear`. Use `pngjs` for pixel-level checks (dimensions, specific pixel values), or have the user view in a browser.

See also: `feedback_rollup_fix.md` (related Linux-deps symptom on the build side).
