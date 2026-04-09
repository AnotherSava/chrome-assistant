# Unified Cache Orchestrator

## Overview

Replace the multiple independent async operations in the cache manager (startFetch, prioritizeLabel, setScopeFilter, startGapFill, runGapFill, startBackgroundExpansion) with a single orchestrator loop. The orchestrator fetches one page at a time, stores results, then re-evaluates what to do next based on the current filter configuration and cache state. No generation counters, no concurrent API calls, no rate limit conflicts.

## Context

- Files involved:
  - Rewrite: `packages/site-gmail/src/cache-manager.ts` — replace all async operations with orchestrator loop and `decide()` function
  - Modify: `packages/site-gmail/src/gmail-api.ts` — expose per-page fetch (return page token for continuation) instead of full-pagination wrappers
  - Modify: `packages/site-gmail/src/background.ts` — replace `startCacheIfNeeded`, `ensureScopeFilter`, `pushUpdatedResults` with `setFilterConfig()` signal to orchestrator
  - Modify: `packages/site-gmail/src/sidepanel.ts` — minimal changes (receives same messages)
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — rewrite for orchestrator behavior
  - Modify: `packages/site-gmail/tests/background.test.ts` — update for new API
  - Modify: `packages/site-gmail/tests/gmail-api.test.ts` — per-page fetch tests
- Related patterns: current `fetchLabelMessageIds` already paginates internally; `labelIdx:*` stores per-label message IDs; `scopedIdSets` caches scoped IDs per timestamp; `cacheDepth` tracks coverage
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Single loop, configurable concurrency.** The orchestrator runs a loop: call `decide(concurrency)` to determine up to N actions, fetch pages in parallel, store results, then loop back. Default concurrency is 1 (sequential, avoids rate limits). Can be increased to 2-3 for faster builds without code changes. `decide()` returns non-conflicting actions — e.g., pages for different labels can run in parallel, but two pages of the same label are sequential (page token dependency).

**`decide()` is the brain.** It examines the current filter configuration (from the service worker) and the cache state (from IndexedDB + in-memory) and returns up to N non-conflicting actions. When nothing is needed, it returns an empty list and the loop sleeps until signaled.

**Conflict rules for parallel actions:**
- Pages for different labels → OK in parallel
- Two pages of the same label → sequential (page token dependency)
- `fetch-scope` + `fetch-label` → OK (different API endpoints)
- Same action type for different labels → OK

**Filter configuration.** The service worker calls `setFilterConfig({ labelId, includeChildren, scopeTimestamp })` whenever the user changes selection or scope. This doesn't trigger any fetch — it just updates what the orchestrator considers "needed." The loop re-evaluates on its next iteration.

**Priority order in `decide()`:**
1. **Scoped IDs needed** — user has a scope active but we don't have the scoped ID set for that timestamp → fetch next page of `messages.list q=after:DATE`
2. **Selected label missing** — user selected a label but its `labelIdx:*` doesn't exist → fetch next page of that label's messages
3. **Initial cache build** — labels not yet fully indexed → fetch next page of the next unprocessed label
4. **Gap-fill** — user's scope is wider than cache depth → fetch next page of gap-fill for the next label
5. **Background expansion** — cache depth is partial, nothing else to do → fetch next page of expansion for the next label and tier
6. **Incremental refresh** — cache is complete but stale (>10 min) → fetch next page of refresh for the next label
7. **Idle** — everything is cached and fresh → return null, sleep

**Per-page API functions.** `fetchLabelMessageIds` currently paginates internally and returns all IDs at once. The orchestrator needs per-page control — fetch one page, get the results + next page token, store results, then decide whether to continue or switch to higher-priority work. New functions: `fetchLabelMessageIdsPage(labelId, pageToken?, scopeDate?, beforeDate?)` and `fetchScopedMessageIdsPage(scopeDate, pageToken?)`.

**Continuation state.** The orchestrator tracks in-progress pagination: `{ type, labelId?, pageToken, scopeDate?, beforeDate? }`. When `decide()` returns the same type as the current continuation, the next page is fetched. When priorities change, the continuation is abandoned (can be resumed later if priorities shift back, since page tokens remain valid for a while).

**Signaling.** When the loop is idle (decide returned null), it waits on a Promise that resolves when:
- `setFilterConfig()` is called (user changed filter)
- `wake()` is called (external trigger, e.g., labels ready, cache invalidated)
The loop then re-evaluates immediately.

**Progress reporting.** The orchestrator emits progress based on what it's currently doing:
- "Background caching: labels 5/157 — INBOX" (initial build)
- "Fetching scope 3000" (scoped ID fetch)
- "Expanding cache: labels 2/157 — Work" (gap-fill / expansion)
- Error icon with tooltip on API failures

**No generation counters.** The loop is sequential — one API call at a time by default. When `setFilterConfig()` changes state, the current page finishes, then `decide()` naturally picks up the new priority. No races, no stale results, no competing operations.

**`decide()` must be fast.** It's called after every page (~every 700ms). It must be a pure in-memory lookup — check filter config, continuation state, and in-memory cache state. No IndexedDB reads in `decide()`. Track which labels are processed, current depth, and continuation tokens in memory.

**Concurrency built in, default 1.** The loop and `decide()` support N parallel actions from the start. Default concurrency is 1 (sequential, avoids 429 rate limits). Increasing to 2-3 is a config change — no architectural rework needed. The progressive depth approach already makes initial load fast (scoped fetch shows results in seconds).

**Cross-referencing stays inline.** After fetching a page of message IDs for a label, the orchestrator calls `crossReferenceLabel()` to store them in IndexedDB before fetching the next page. Each iteration is self-contained: fetch → store → decide.

**Label list fetch.** `fetchLabels()` (the Gmail label list API call) runs once at orchestrator startup before the loop begins. It's a prerequisite for everything else and is a single fast call. The result is stored in `this.labels` and used by `decide()` to know which labels exist.

**Scoped index computation.** After all pages of a scoped ID fetch complete (no more page tokens), the orchestrator intersects the scoped IDs with label indexes to build `scopedLabelIdx`, same as today. This is a local computation, not an API call.

**Cache depth updates.** After a gap-fill or expansion tier completes all labels, the orchestrator updates `cacheDepth` in IndexedDB. `decide()` uses this to determine if more expansion is needed.

## Implementation Steps

### Task 1: Per-page API functions

**Files:**
- Modify: `packages/site-gmail/src/gmail-api.ts`
- Modify: `packages/site-gmail/tests/gmail-api.test.ts`

- [x] Add `fetchLabelMessageIdsPage(labelId, pageToken?, scopeDate?, beforeDate?)` — returns `{ ids: string[], nextPageToken: string | null }`
- [x] Add `fetchScopedMessageIdsPage(scopeDate, pageToken?)` — returns `{ ids: string[], nextPageToken: string | null }`
- [x] Keep existing full-pagination wrappers (used by tests, may be removed later)
- [x] Add tests for per-page functions
- [x] Run project test suite — must pass before next task

### Task 2: Orchestrator core loop and decide()

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Add `FilterConfig` type: `{ labelId: string | null, includeChildren: boolean, scopeTimestamp: number | null }`
- [x] Add `setFilterConfig(config)` — stores config, wakes the loop if idle
- [x] Add `decide(concurrency)` method — examines filter config + cache state, returns up to N non-conflicting actions (empty list = idle). Enforces conflict rules (no two pages for the same label).
- [x] Add orchestrator loop: `start()` runs the loop, `stop()` exits it. Each iteration: `actions = decide(concurrency)`, if empty sleep, else `Promise.all(actions.map(execute))` + store results.
- [x] Add continuation state tracking for multi-page fetches
- [x] Add signal/wake mechanism for idle → active transition
- [x] Add tests: decide returns correct action based on state, loop processes pages, priority changes mid-pagination
- [x] Run project test suite — must pass before next task

### Task 3: Implement each action type

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] **fetch-scope**: fetch one page of scoped IDs, accumulate. When complete (no nextPageToken), build scopedLabelIdx.
- [x] **fetch-label**: fetch one page of a label's message IDs, crossReferenceLabel immediately. When complete, mark label as processed.
- [x] **gap-fill-label**: fetch one page of a label's gap segment (afterDate + beforeDate), merge into existing index. When all labels done, update cacheDepth.
- [x] **expand-label**: same as gap-fill but for background expansion tiers. When tier complete, update cacheDepth, move to next tier.
- [x] **refresh-label**: fetch one page of a label's messages since lastFetchTimestamp. When all labels done, update lastFetchTimestamp.
- [x] Add tests for each action type
- [x] Run project test suite — must pass before next task

### Task 4: Wire service worker to orchestrator

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/background.test.ts`

- [x] Replace `startCacheIfNeeded` with `orchestrator.start()` on first Gmail tab detection (idempotent — if already running, just updates config)
- [x] Replace `ensureScopeFilter` with `orchestrator.setFilterConfig()`
- [x] Simplify `selectionChanged` handler — just call `setFilterConfig()` + query from cache (orchestrator handles fetching)
- [x] Simplify `pushUpdatedResults` — orchestrator's progress callback triggers UI refresh
- [x] Remove `prioritizeLabel`, `setScopeFilter`, `startGapFill`, `startBackgroundExpansion`, `runGapFill`, generation counters
- [x] Add tests for service worker → orchestrator integration
- [x] Run project test suite — must pass before next task

### Task 5: Progress reporting

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`

- [x] Orchestrator emits progress after each page based on current action type
- [x] Error reporting: on API failure, emit error text in progress, back off (1s delay), then re-decide
- [x] Sidepanel displays progress as before (labels X/Y, fetching scope N, expanding, error icon)
- [x] Run project test suite — must pass before next task

### Task 6: Verify acceptance criteria

- [x] Manual test: first load with scope — cache builds scoped data first, then expands (skipped - not automatable)
- [x] Manual test: click label during cache build — label is fetched immediately (priority switch) (skipped - not automatable)
- [x] Manual test: change scope during cache build — scope fetch interrupts label caching, then resumes (skipped - not automatable)
- [x] Manual test: widen scope — gap-fill runs, narrowing back is instant (cached) (skipped - not automatable)
- [x] Manual test: no 429 errors (single API call at a time) (skipped - not automatable)
- [x] Manual test: progress bar shows current activity accurately (skipped - not automatable)
- [x] Run full test suite: `npm test` — 220 tests passed
- [x] Run linter: `npm run lint` — clean

### Task 7: Update documentation

- [x] Update CLAUDE.md if internal patterns changed
- [x] Update `docs/pages/data-flow.md` — replace multi-loop architecture with orchestrator
- [x] Move this plan to `docs/plans/completed/`
