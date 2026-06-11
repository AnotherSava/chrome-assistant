---
name: claude-mermaid Windows bug
description: The claude-mermaid MCP plugin fails on Windows with "spawn npx ENOENT" — execFile("npx") needs to be execFile("npx.cmd") on Windows
type: reference
---
The claude-mermaid plugin (veelenga/claude-mermaid) fails on Windows with `spawn npx ENOENT`. Root cause: `handlers.ts:70` calls `execFileAsync("npx", args)` but on Windows `npx` is `npx.cmd` and `execFile` doesn't resolve `.cmd` extensions. Installing globally doesn't help — the internal rendering call still uses `execFile("npx")`. Needs upstream fix (use `spawn` with `shell: true`, or detect Windows and use `npx.cmd`). Write `.mmd` files directly until fixed.
