---
name: Rollup native module fix
description: After external review tools run npm, @rollup/rollup-win32-x64-msvc goes missing — skip diagnosis and reinstall immediately
type: feedback
---

When `npm run build` fails with "'vite' is not recognized" or "Cannot find module @rollup/rollup-win32-x64-msvc", run `npm install @rollup/rollup-win32-x64-msvc` immediately, then retry `npm run build`. Don't diagnose further.

**Why:** ralphex runs in a Docker container on WSL, so its `npm install` installs Linux-native optional dependencies, overwriting the Windows ones in the shared `node_modules/`. This happens after every ralphex review.

**How to apply:** On either symptom ("vite not recognized" OR rollup native module error), skip straight to `npm install @rollup/rollup-win32-x64-msvc` then retry the build. No intermediate steps needed.
