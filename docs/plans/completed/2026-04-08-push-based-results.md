# Push-Based Results from Cache Manager

## Overview

Replace the request/response pattern between service worker and cache manager with a push-based model. The service worker calls `setFilterConfig()` each time the user changes filter criteria — the cache manager pushes results via a callback whenever it has useful data. No `computeResults`, no `seq` correlation, no separate `fetchCounts`. The cache manager decides when to push based on data availability: immediately if cached, after fetches if not, and again when data improves (cache completes, gap-fill finishes, scope ready).

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/cache-manager.ts` — add result push callback, remove `computeResults` as a service-worker-facing API, push results from orchestrator loop on meaningful completions
  - Modify: `packages/site-gmail/src/background.ts` — replace `computeResults` + `setFilterConfig` dual call with single `setFilterConfig`, register result callback, relay pushes to sidepanel + Gmail navigation
  - Modify: `packages/site-gmail/src/sidepanel.ts` — remove `sendSelectionChanged` + `requestCounts` dual sends, remove `seq` correlation, handle pushed results
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — push callback tests
  - Modify: `packages/site-gmail/tests/background.test.ts` — simplified handler tests
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — remove seq tests
- Related patterns: `cacheState` progress already uses push (cache manager emits, service worker relays); `pushUpdatedResults` in service worker already pushes on cache complete
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**`setFilterConfig` is the only API.** The service worker calls `cacheManager.setFilterConfig({ labelId, includeChildren, scope })` when the user changes any filter criteria. This is not a query — it's informing the cache manager what the user is looking at. The cache manager decides what to do with it.

**Cache manager pushes results via callback.** A registered `onResults` callback receives `{ labelId, count, coLabelCounts, counts }` — combining what was previously split between `labelResult` and `countsReady`. The cache manager calls this callback whenever it has useful data to show:
- Immediately after `setFilterConfig` if the data is already cached
- After the orchestrator fetches a missing label or scope
- After cache build completes (improved co-label accuracy)
- After gap-fill or expansion completes (wider coverage)
The cache manager doesn't push when it has nothing useful (e.g., label not cached yet, scope not fetched) — the sidepanel keeps showing whatever it had before.

**No `seq` correlation.** There's no request to correlate with. Each push is the latest state for the current filter config. If `setFilterConfig` is called again before a push arrives, the cache manager discards any pending work for the old config and starts working on the new one (existing orchestrator behavior via `decide()` re-prioritization).

**Staleness handled by filter config comparison.** Instead of `seq` matching, the push callback includes the `filterConfig` it was computed for. The service worker (or sidepanel) compares it to the current config and ignores stale pushes.

**Gmail navigation decoupled from cache manager.** The service worker navigates Gmail immediately when it receives `selectionChanged` from the sidepanel — this is independent of the cache manager. The cache manager only pushes data results; it has no knowledge of Gmail navigation. This keeps concerns separate: sidepanel → service worker for navigation, cache manager → service worker for data.

**`fetchCounts` message removed.** Currently the sidepanel sends `fetchCounts` separately for label counts. With push-based results, the cache manager pushes counts as part of every result. The `fetchCounts` message and its handler are removed.

**`computeResults` becomes internal.** The `computeResults` method still exists inside the cache manager (used by the push logic to compute results), but it's no longer called by the service worker. The service worker only calls `setFilterConfig`.

**`pushUpdatedResults` absorbed.** The service worker's `pushUpdatedResults` function (called on cache complete) is replaced by the cache manager's own push logic — it pushes updated results automatically when the orchestrator completes meaningful work.

**Unaddressed Codex findings from orchestrator review.** These edge cases from the previous review should be verified during this refactor:
- Refresh alarm resets on every "complete" event (partially fixed — `chrome.alarms.get` check added, but "complete" still fires on multiple occasions)

## Implementation Steps

### Task 1: Add result push callback to cache manager

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Add `ResultPush` type: `{ labelId: string | null, count: number, coLabelCounts: Record<string, number>, counts: Record<string, { own: number; inclusive: number }>, filterConfig: FilterConfig }`
- [x] Add `setResultCallback(callback: (result: ResultPush) => void)` method
- [x] After `setFilterConfig` is called: if data is available, compute and push immediately. If not, the orchestrator will push when data arrives.
- [x] In the orchestrator loop: after meaningful completions (label indexed, scope ready, cache complete, gap-fill done), compute results for the current filter config and push via callback
- [x] `computeResults` remains as an internal method but is no longer exported for service worker use
- [x] Add test: setFilterConfig with cached data pushes immediately
- [x] Add test: setFilterConfig with missing data pushes after orchestrator fetches
- [x] Add test: filter config change during fetch pushes new results (not stale)
- [x] Run project test suite — must pass before next task

### Task 2: Simplify service worker to relay pushes

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/background.test.ts`

- [x] Register result callback on cache manager — on push: send `labelResult` and `countsReady` to sidepanel ports
- [x] Replace `selectionChanged` handler: navigate Gmail immediately (independent of cache manager), then call `setFilterConfig`. Remove direct `computeResults` call.
- [x] Remove `fetchCounts` handler — counts are pushed by cache manager
- [x] Remove `pushUpdatedResults` — absorbed by cache manager push logic
- [x] Remove `lastSelection` tracking — cache manager tracks filter config internally
- [x] Add test: result push relayed to sidepanel
- [x] Add test: Gmail navigation happens on selectionChanged, not on push
- [x] Run project test suite — must pass before next task

### Task 3: Simplify sidepanel messaging

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Remove `requestCounts` and `fetchCounts` message sending — counts arrive via pushed results
- [x] Remove `fetchCountsSeq`, `countsInFlight`, `countsPending` — no more request/response for counts
- [x] Remove `queryLabelSeq` — no request/response for label queries
- [x] Scope change handler: just send `selectionChanged` (already done)
- [x] `countsReady` handler: accept pushed counts, update UI as before
- [x] Remove seq checks from `labelResult` and `countsReady` handlers — staleness handled by filter config comparison
- [x] Add test: pushed results update UI without seq matching
- [x] Run project test suite — must pass before next task

### Task 4: Verify acceptance criteria

- [x] Manual test: click label — results appear (skipped - not automatable)
- [x] Manual test: change scope — old counts stay visible, new counts replace when ready (skipped - not automatable)
- [x] Manual test: rapid filter changes — no stale results shown (skipped - not automatable)
- [x] Manual test: cache complete — counts update automatically (skipped - not automatable)
- [x] Manual test: no 429 errors, no redundant API calls (skipped - not automatable)
- [x] Run full test suite: `npm test` — 228 tests passing
- [x] Run linter: `npm run lint` — clean

### Task 5: Update documentation

- [x] Update `docs/pages/data-flow.md` to match target state below — remove NOTE markers, describe push-based model as current
- [x] Update CLAUDE.md if internal patterns changed
- [x] Move this plan to `docs/plans/completed/`

## Target data-flow.md: Filter Change flow

```markdown
### Filter Change

1. User changes filter criteria in the sidepanel (clicks label, changes scope, toggles include-children)
2. Sidepanel sends `selectionChanged { labelId, includeChildren, scope }`
3. Service worker navigates Gmail immediately (resolves label names, builds URL, updates tab)
4. Service worker calls `cacheManager.setFilterConfig({ labelId, includeChildren, scope })`
5. Cache manager pushes results via registered callback whenever data is available:
   - Immediately if data is cached
   - After orchestrator fetches missing label/scope data
   - Again when cache completes, gap-fill finishes, or expansion adds data
6. Service worker relays each push as `labelResult` and `countsReady` to sidepanel
7. Sidepanel renders whatever arrives — progressively accurate counts

No request/response. No seq correlation. Staleness handled by filter config comparison in push callback.
```
