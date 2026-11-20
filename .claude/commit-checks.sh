#!/usr/bin/env bash
# What /yolo and /wrap-up run before they commit here, and what the shared push step runs over the
# tree a push would publish. This repo commits straight to main and has no CI, so nothing else reads
# a change on its way in.
#
# Steps, cheapest first:
#   conventions  ~/.claude/conventions/check.py — every rule this repo's adopted version takes on.
#   lint         `tsc --noEmit` over packages/**/*.ts. The only type check: vite builds without one,
#                so a type error passes `npm run build` and only this step catches it.
#   test         vitest.
#   build        the Gmail extension bundle, the same `npm run build` that `npm run package` runs
#                before zipping for the Chrome Web Store.
#
# What a pass does not cover: the extension loading in Chrome, OAuth, and anything against live
# Gmail. No linter or formatter is configured, so there is no style step. The Web Store packaging
# step is a release action and is left out; its build half is the build step above.
#
# Prerequisites are python3 and npm on PATH. Their absence fails rather than skips: a check that
# cannot tell "passed" from "never ran" turns an open problem into a closed-looking one.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

status=0

# Buffer each step and print its output only when it fails, so a pass is one line and a failure
# shows everything the tool said. The pass line keeps the tool's last line, which for the
# conventions checker names the rules it ran. A tool silent on success (tsc) reads "ok"; npm runs
# with --silent so its command echo does not stand in for the tool's own output.
run() {
  local label="$1" out last
  shift
  out="$(mktemp)"
  if "$@" >"$out" 2>&1; then
    last="$(sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -v '^[[:space:]]*$' | tail -n 1)"
    echo "==> $label — ${last:-ok}"
  else
    echo "==> $label — FAILED"
    cat "$out"
    status=1
  fi
  rm -f "$out"
}

run "Conventions" python3 ~/.claude/conventions/check.py .
run "Lint (tsc --noEmit)" npm run --silent lint
run "Tests" npm run --silent test
run "Build" npm run --silent build

exit "$status"
