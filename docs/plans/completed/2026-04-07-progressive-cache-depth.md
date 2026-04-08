# Progressive Cache Deepening

## Overview

Rework the cache build to fetch what the user needs first. Instead of fetching all messages for every label (which takes minutes for large mailboxes), the initial cache build uses the active scope as a filter — fetching only messages within the current time range. Narrowing scope is instant (subset of cached data + one scoped ID set API call). Widening scope fetches only the missing time segment incrementally. Full unscoped coverage builds up over time.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/cache-manager.ts` — scoped initial fetch, cache depth tracking, incremental deepening, gap-fill logic
  - Modify: `packages/site-gmail/src/gmail-api.ts` — add `beforeDate` parameter to `fetchLabelMessageIds`
  - Modify: `packages/site-gmail/src/background.ts` — pass active scope to cache build, trigger deepening on scope widening
  - Modify: `packages/site-gmail/src/sidepanel.ts` — minor: scope change triggers deepening instead of separate scope fetch
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — depth tracking, gap-fill, narrowing/widening tests
  - Modify: `packages/site-gmail/tests/gmail-api.test.ts` — beforeDate parameter tests
- Related patterns: `fetchLabelMessageIds` already supports `scopeDate` (after); `labelIdx:*` stores per-label message IDs; `scopedLabelIdx` holds scoped intersections in memory; `fetchScopedMessageIds` fetches all scoped IDs in one call
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Cache depth metadata.** IndexedDB meta stores `cacheDepth: { timestamp: number | null }` — the oldest date covered by label indexes. `null` means full coverage (no scope limit). A timestamp means "we have all messages newer than this date for every label."

**Initial cache build uses active scope.** `startFetch` receives the current `scopeTimestamp` from the service worker. If set, Phase 1 fetches per-label with `after:DATE`. If null ("any"), fetches without scope (full coverage). The `cacheDepth` is set accordingly.

**Narrowing scope is local.** When the user narrows scope (e.g., 3 years → 1 year), the new scope is within `cacheDepth`. Use `fetchScopedMessageIds` (one API call) to get the narrower ID set, then intersect with existing `labelIdx:*` entries. No per-label API calls.

**Widening scope fetches the gap.** When the user widens scope (e.g., 3 years → 5 years), the new scope extends beyond `cacheDepth`. For each label, fetch the missing segment: `fetchLabelMessageIds(labelId, newScopeDate, cacheDepthDate)` using `after:` and `before:`. Merge new IDs into `labelIdx:*`. Update `cacheDepth` to the wider date.

**"Any" scope widens to full.** Selecting "any" when `cacheDepth` is set triggers a gap-fill from `cacheDepth` backward (no `after:`, `before:cacheDepthDate`). After completion, `cacheDepth` is set to `null` (full coverage). Can be done in the background.

**Scoped ID sets cached for fast switching.** `scopedIdSets: Map<timestamp, Set<string>>` caches the results of `fetchScopedMessageIds` in memory. Switching back to a previously-used scope is instant (cache hit → local intersection). Up to 5 entries, LRU eviction.

**`fetchLabelMessageIds` gains `beforeDate` parameter.** The query becomes `after:DATE before:DATE` to fetch any time segment — gap-fill for widening (older messages), incremental refresh for new messages (after last fetch timestamp), or full fetch (no dates). Same function handles all three cases.

**Depth-aware incremental refresh.** On subsequent cache runs (10-minute refresh), the incremental fetch uses `lastFetchTimestamp` as the `after:` date — only fetching new messages since last run, within the current depth. Same `fetchLabelMessageIds(labelId, afterDate, beforeDate)` function used for gap-fill and refresh.

**Background depth expansion.** The cache can deepen in the background as a lower-priority activity. When the user has "3 years" scope, the cache serves that immediately. Meanwhile, it can silently expand to 5 years, then all time — so when the user eventually widens scope, the data is already there. This runs after the initial build completes, using gap-fill requests during idle time.

**Gap-fill is background work.** Widening scope triggers a gap-fill that runs per-label. The user sees immediate results from the scoped ID set intersection (using existing cached data for what we have), while the gap-fill expands coverage in the background. Progress shows "Expanding cache: labels X/Y".

## Implementation Steps

### Task 1: Add `beforeDate` to `fetchLabelMessageIds`

**Files:**
- Modify: `packages/site-gmail/src/gmail-api.ts`
- Modify: `packages/site-gmail/tests/gmail-api.test.ts`

- [x] Add `beforeDate?: string` parameter to `fetchLabelMessageIds` — appends `before:DATE` to the query when set
- [x] Add test: fetchLabelMessageIds with both scopeDate and beforeDate produces correct query
- [x] Run project test suite — must pass before next task

### Task 2: Cache depth tracking and scoped initial build

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Add `cacheDepth` metadata to IndexedDB meta store — `{ timestamp: number | null }` where null = full coverage
- [x] `startFetch` accepts `scopeTimestamp` parameter. When set, Phase 1 uses `fetchLabelMessageIds(labelId, scopeDate)`. Stores `cacheDepth: { timestamp: scopeTimestamp }` on completion.
- [x] Service worker passes the active `scopeTimestamp` from sidepanel settings to `startFetch`
- [x] Add test: initial build with scope stores scoped label indexes and correct cacheDepth
- [x] Add test: initial build without scope stores full indexes and cacheDepth null
- [x] Run project test suite — must pass before next task

### Task 3: Narrowing scope (local intersection)

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] In `setScopeFilter`: if new scope is within `cacheDepth` (narrower or equal), use `fetchScopedMessageIds` + local intersection (current behavior, no change needed — just verify)
- [x] Add test: narrowing scope within cache depth doesn't trigger per-label API calls
- [x] Run project test suite — must pass before next task

### Task 4: Widening scope (gap-fill)

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] In `setScopeFilter`: if new scope is wider than `cacheDepth`, trigger gap-fill. For each label, call `fetchLabelMessageIds(labelId, newScopeDate, cacheDepthDate)` to fetch the missing segment. Merge new IDs into `labelIdx:*`. Update `cacheDepth`.
- [x] Gap-fill runs as background work with progress: "Expanding cache: labels X/Y"
- [x] While gap-fill runs, use `fetchScopedMessageIds` + intersect with existing (partial) indexes for immediate results
- [x] "Any" scope: gap-fill from cacheDepth backward using `before:cacheDepthDate` (no `after:`)
- [x] Add test: widening scope triggers per-label gap-fill for missing segment only
- [x] Add test: "any" scope from partial cache triggers backward fill
- [x] Add test: cacheDepth updated after gap-fill completes
- [x] Run project test suite — must pass before next task

### Task 5: Incremental refresh and background depth expansion

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] On incremental refresh (cache already complete), fetch per-label with `after:lastFetchTimestamp` (no `before:`) — gets new messages since last run. Same `fetchLabelMessageIds` with `beforeDate` left undefined.
- [x] Don't regress depth on incremental refresh — keep the widest depth achieved
- [x] After initial build and refresh complete, if `cacheDepth` is not null, start background depth expansion: gap-fill one step deeper (e.g., 3y → 5y → all). Runs at low priority, interruptible by user actions.
- [x] Add test: incremental refresh fetches only new messages
- [x] Add test: background expansion deepens cache progressively
- [x] Run project test suite — must pass before next task

### Task 6: Verify acceptance criteria

- [x] Manual test: first load with "3 years" scope — cache builds fast (only 3 years of data) (skipped - not automatable)
- [x] Manual test: narrow to "1 year" — counts update instantly (one API call + local intersection) (skipped - not automatable)
- [x] Manual test: widen to "5 years" — immediate partial results, background gap-fill expands (skipped - not automatable)
- [x] Manual test: switch to "any" — immediate partial results, background fills remaining (skipped - not automatable)
- [x] Manual test: switch back to "3 years" — instant (cached scoped ID set) (skipped - not automatable)
- [x] Manual test: reload extension — cache depth persists, no redundant re-fetching (skipped - not automatable)
- [x] Run full test suite: `npm test` — 166 tests passed
- [x] Run linter: `npm run lint` — clean

### Task 7: Update documentation

- [x] Update CLAUDE.md if internal patterns changed
- [x] Update `docs/pages/data-flow.md` — add progressive deepening flow
- [x] Move this plan to `docs/plans/completed/`
