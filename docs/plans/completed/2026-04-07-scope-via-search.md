# Replace Phase 2 Date Fetching with Search-Based Scope

## Overview

Replace the batch API date-fetching Phase 2 (which hits rate limits and takes hours for large mailboxes) with a single `messages.list` search call when scope changes. Instead of storing per-message dates and filtering locally, fetch all message IDs within the scope via `messages.list q=after:DATE`, then intersect with existing label indexes for instant filtered counts. One paginated API call per scope change, no batch API, no dates in IndexedDB.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/cache-manager.ts` — remove Phase 2, add scope search, intersect with label indexes
  - Modify: `packages/site-gmail/src/cache-db.ts` — remove `getMessagesWithoutDates`, `countMessagesWithoutDates`, date-related status logic
  - Modify: `packages/site-gmail/src/gmail-api.ts` — remove `batchFetchDates`, `buildBatchRequestBody`, `parseBatchResponse`, batch API code
  - Modify: `packages/site-gmail/src/background.ts` — pass scope to cache manager for search, remove batch-related error handling
  - Modify: `packages/core/src/types.ts` — simplify `CacheMessage` (remove `status` field, remove `internalDate`)
  - Modify: `packages/core/src/sidepanel.css` — remove `.cache-error` style (no more batch errors)
  - Modify: `packages/site-gmail/src/sidepanel.ts` — remove error icon from progress bar, remove dates phase display
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — remove Phase 2 tests, add scope search tests
  - Modify: `packages/site-gmail/tests/cache-db.test.ts` — remove date-related tests
  - Modify: `packages/site-gmail/tests/gmail-api.test.ts` — remove batch API tests
- Related patterns: `fetchLabelMessageIds` already paginates `messages.list`; label indexes (`labelIdx:*`) already map labels to message IDs; `getLabelCounts` already iterates label indexes
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**One API call per scope change.** When the user selects a scope (e.g., "3 years ago"), make a single `messages.list q=after:DATE` call (paginated). This returns all message IDs within the scope across all labels.

**Pre-compute filtered label indexes.** After fetching scoped message IDs, intersect once per label with its `labelIdx:*` entries and store the result as `scopedLabelIdx: Map<string, string[]>` in memory. `queryLabel` and `getLabelCounts` read from `scopedLabelIdx` when scope is active, same code path as reading `labelIdx:*` when unscoped. No per-query intersection — the work is done once at scope-change time.

**No dates in IndexedDB.** `CacheMessage` no longer needs `internalDate` or `status`. Records become just `{ id, labelIds }`. Phase 2 is completely removed — no batch API, no date fetching, no rate limit issues.

**Scoped indexes cached in memory.** The `scopedLabelIdx` map is held in the cache manager instance. It's rebuilt when scope changes. On service worker restart, it's empty — the next `fetchCounts` or `queryLabel` with a scope triggers a fresh search + rebuild.

**"Any" scope = no filtering.** When scope is null, the scoped set is not used. Counts and queries operate on the full label indexes. No API call needed.

**Progress bar simplification.** Only the "labels" phase exists. No "dates" phase, no error icon. Cache completion is faster (just label cross-referencing).

**`fetchLabelMessageIds` reused for scope search.** The same pagination logic works — call with no `labelId` filter and just `q=after:DATE`. Need a new function or parameter to support a query-only search without `labelIds=`.

**`queryLabel` and `getLabelCounts` use a common index accessor.** Both read label indexes via a helper that returns `scopedLabelIdx.get(labelId)` when scope is active, or falls back to `db.getMeta(labelIdx:${labelId})` when unscoped. This keeps the query and count code paths identical regardless of scope.

## Implementation Steps

### Task 1: Add scope search to cache manager

**Files:**
- Modify: `packages/site-gmail/src/gmail-api.ts` — add `fetchScopedMessageIds(scopeDate)` using `messages.list q=after:DATE` (no label filter)
- Modify: `packages/site-gmail/src/cache-manager.ts` — add `setScopeFilter(scopeTimestamp)` that calls the API and stores the scoped set; update `queryLabel` and `getLabelCounts` to intersect with scope set
- Modify: `packages/site-gmail/tests/cache-manager.test.ts` — tests for scope intersection

- [x] Add `fetchScopedMessageIds(scopeDate: string): Promise<string[]>` to gmail-api — paginates `messages.list` with `q=after:DATE` (no `labelIds` parameter)
- [x] Add `scopedLabelIdx: Map<string, string[]> | null` to cache manager — null means no scope filter
- [x] Add `setScopeFilter(scopeTimestamp: number | null)` — if not null, converts to date string, calls `fetchScopedMessageIds`, intersects with each `labelIdx:*` entry, stores results in `scopedLabelIdx`. If null, clears the map.
- [x] Add `getLabelIndex(labelId): Promise<string[] | undefined>` helper — returns `scopedLabelIdx.get(labelId)` when scope is active, or `db.getMeta(labelIdx:${labelId})` when unscoped. Used by both `queryLabel` and `getLabelCounts`.
- [x] Update `queryLabel` — use `getLabelIndex` instead of direct `db.getMeta` reads
- [x] Update `getLabelCounts` / `getFilteredLabelCounts` — use `getLabelIndex` instead of direct `db.getMeta` reads
- [x] Remove `scopeFallback` — no longer needed
- [x] Add test: queryLabel with scope returns filtered results
- [x] Add test: getLabelCounts with scope returns filtered counts
- [x] Add test: null scope reads from IndexedDB directly
- [x] Run project test suite — must pass before next task

### Task 2: Wire scope changes through service worker

**Files:**
- Modify: `packages/site-gmail/src/background.ts` — call `setScopeFilter` when scope changes via `selectionChanged` or `fetchCounts`
- Modify: `packages/site-gmail/tests/background.test.ts` — tests for scope propagation

- [x] In `selectionChanged` handler: call `cacheManager.setScopeFilter(scopeTimestamp)` before querying
- [x] In `fetchCounts` handler: call `cacheManager.setScopeFilter(scopeTimestamp)` before getting counts
- [x] Cache the current scope in the service worker to avoid redundant API calls when scope hasn't changed
- [x] Add test: selectionChanged with scope triggers setScopeFilter
- [x] Add test: same scope doesn't re-fetch
- [x] Run project test suite — must pass before next task

### Task 3: Remove Phase 2 and batch API

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts` — remove `fetchDates`, Phase 2 code
- Modify: `packages/site-gmail/src/cache-db.ts` — remove `getMessagesWithoutDates`, `countMessagesWithoutDates`
- Modify: `packages/site-gmail/src/gmail-api.ts` — remove `batchFetchDates`, `buildBatchRequestBody`, `parseBatchResponse`, `BatchPart`, `BatchDateResult`
- Modify: `packages/core/src/types.ts` — remove `internalDate` and `status` from `CacheMessage`
- Modify: `packages/site-gmail/tests/cache-db.test.ts` — remove date-related tests
- Modify: `packages/site-gmail/tests/gmail-api.test.ts` — remove batch API tests

- [x] Remove `fetchDates` method and all Phase 2 logic from cache manager
- [x] Remove `batchFetchDates`, `buildBatchRequestBody`, `parseBatchResponse`, `filterBatchParts`, `BatchPart`, `BatchDateResult` from gmail-api
- [x] Remove `getMessagesWithoutDates`, `countMessagesWithoutDates` from cache-db
- [x] Remove `internalDate` and `status` from `CacheMessage` type
- [x] Update `crossReferenceLabel` to create records without `internalDate`/`status`
- [x] Remove dates phase from `CacheProgress` (keep labels + complete only)
- [x] Remove all deleted-function tests
- [x] Run project test suite — must pass before next task

### Task 4: Simplify sidepanel progress display

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts` — remove dates phase display, remove error icon
- Modify: `packages/core/src/sidepanel.css` — remove `.cache-error` style

- [x] Remove "dates" phase from `updateCacheProgress` — only "labels" and "complete"
- [x] Remove error count tracking and error icon from progress bar
- [x] Remove `errors` from `lastCacheProgress` type
- [x] Run project test suite — must pass before next task

### Task 5: Verify acceptance criteria

- [x] Manual test: set scope to 1 month — label counts update (single API call, no batch) (skipped - not automatable)
- [x] Manual test: change scope — counts update again (one API call) (skipped - not automatable)
- [x] Manual test: set scope to "any" — all labels shown, no API call (skipped - not automatable)
- [x] Manual test: cache build completes quickly (labels phase only, no dates phase) (skipped - not automatable)
- [x] Manual test: select a label with scope — co-labels filtered correctly (skipped - not automatable)
- [x] Manual test: no 429 errors in console (skipped - not automatable)
- [x] Run full test suite: `npm test` — 156 tests pass
- [x] Run linter: `npm run lint` — clean

### Task 6: Update documentation

- [x] Update CLAUDE.md if internal patterns changed
- [x] Update `docs/pages/data-flow.md` — remove Phase 2, add scope search flow
- [x] Move this plan to `docs/plans/completed/`
