# Unify Label Selection into selectionChanged Message

## Overview

Replace the paired `queryLabel` + `applyFilters` messages with a single `selectionChanged` message. The sidepanel expresses intent ("I selected label X") and the service worker handles both cache querying and Gmail navigation. Descendant resolution moves from the sidepanel to the cache manager. The `pendingFilterApply` flag and `getDescendantIds` are removed from the sidepanel.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/sidepanel.ts` — replace `sendQueryLabel` + `applyFilters` with single `selectionChanged` message, remove `getDescendantIds`, remove `pendingFilterApply`
  - Modify: `packages/site-gmail/src/background.ts` — add `selectionChanged` handler that delegates to cache manager and navigates Gmail, remove `queryLabel` and `applyFilters` handlers
  - Modify: `packages/site-gmail/src/cache-manager.ts` — `queryLabel` resolves descendants internally via prefix matching instead of receiving pre-resolved `labelIds` array
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — update for new message format
  - Modify: `packages/site-gmail/tests/background.test.ts` — add `selectionChanged` handler tests
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — update `queryLabel` to accept single labelId + includeChildren flag
- Related patterns: cache manager already does prefix matching for `getLabelCounts` inclusive counts; `whenReady` gate ensures cache is available before queries
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Sidepanel expresses intent, not implementation.** The sidepanel sends `selectionChanged(labelId | null, includeChildren, scope, seq)`. It doesn't know about descendant resolution, Gmail URL building, or cache querying. The service worker coordinates these.

**Cache manager resolves descendants.** `queryLabel` changes from `(labelIds: string[], scopeTimestamp)` to `(labelId: string | null, includeChildren: boolean, scopeTimestamp)`. It resolves descendants internally using `startsWith` prefix matching on `this.labels` — the same approach already used by `getLabelCounts`.

**Service worker handles both query and navigation.** On receiving `selectionChanged`, the service worker:
1. Calls `cacheManager.queryLabel(labelId, includeChildren, scopeTimestamp)` — gets count + co-labels
2. Builds Gmail URL using the label name (resolved from `cacheManager.labels` or the label list) and navigates
3. Responds with `labelResult`
For deselection (labelId null), it skips the query, navigates to `#all`, and responds with an empty result.

**`pendingFilterApply` eliminated.** Currently needed because the sidepanel can't resolve descendants without `cachedLabels`. With descendants resolved server-side, the sidepanel can send `selectionChanged` immediately — the service worker's `whenReady` gate ensures the cache is available.

**`resetGmailToInbox` becomes `filtersOff`.** A separate message type for "navigate Gmail to inbox without changing selection state." Used by the Summary tab switch with return-to-inbox enabled.

**Cache-complete re-query is internal to the service worker.** When the cache finishes building, the service worker receives the `cacheState` complete event directly from the cache manager's progress callback. It already knows the active label from the last `selectionChanged` request. It re-queries the cache and pushes an updated `labelResult` + `countsReady` to the sidepanel without the sidepanel asking. The sidepanel only uses `cacheState` messages for progress bar display, not for triggering re-queries.

**`getDescendantIds` removed from sidepanel.** No longer needed — descendant resolution happens in the cache manager. The export and its tests are removed.

## Implementation Steps

### Task 1: Refactor queryLabel to accept single labelId + includeChildren

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Change `queryLabel` signature from `(labelIds: string[], scopeTimestamp)` to `(labelId: string, includeChildren: boolean, scopeTimestamp)`. Internally resolve descendants using `startsWith` prefix matching on `this.labels` when `includeChildren` is true, then union messages as before.
- [x] Update `scopeFallback` similarly — accept single labelId + includeChildren, resolve internally
- [x] Update all `queryLabel` tests to use new signature
- [x] Add test: queryLabel with includeChildren resolves descendants via prefix matching
- [x] Run project test suite — must pass before next task

### Task 2: Add selectionChanged handler in service worker

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/background.test.ts`

- [x] Add `selectionChanged` message handler — receives `{ labelId, includeChildren, scope, seq }`, calls `cacheManager.queryLabel` (if labelId not null), builds Gmail URL via `buildGmailUrl`, navigates Gmail, stores hash in `lastExtensionNavHash`, responds with `labelResult`
- [x] For deselection (labelId null): navigate to `#all` (or `#search/after:DATE` if scope set), respond with empty `labelResult`
- [x] Resolve label name for `buildGmailUrl` from `cacheManager.labels` (the cache manager's label list used for prefix matching)
- [x] Add `filtersOff` message handler — navigates Gmail to `#inbox`, no cache query, no response needed
- [x] Keep `queryLabel` handler temporarily for backward compatibility during migration (remove in Task 3)
- [x] Keep `applyFilters` handler temporarily (remove in Task 3)
- [x] Add test: selectionChanged with labelId triggers query + navigation + labelResult response
- [x] Add test: selectionChanged with null triggers navigation to #all + empty response
- [x] Add test: filtersOff navigates to #inbox
- [x] Run project test suite — must pass before next task

### Task 3: Update sidepanel to use selectionChanged

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Replace `sendQueryLabel()` + `applyFilters()` calls with a single `sendSelectionChanged()` that posts `{ type: "selectionChanged", labelId: activeLabelId, includeChildren, scope: scopeToDate(), seq }`
- [x] Update `selectLabel` to call `sendSelectionChanged()` for both select and deselect (no branching)
- [x] Update scope change handler to call `sendSelectionChanged()`
- [x] Update include-children toggle handler to call `sendSelectionChanged()`
- [x] Remove `pendingFilterApply` flag — on `labelsReady`, just call `sendSelectionChanged()` if `activeLabelId` is set
- [x] Replace `resetGmailToInbox()` with sending `{ type: "filtersOff" }`
- [x] Remove `getDescendantIds` function and its export
- [x] Remove old `sendQueryLabel()` and `applyFilters()` functions
- [x] Remove `queryLabel` and `applyFilters` handlers from background.ts (kept in Task 2 for migration)
- [x] Update all affected tests
- [x] Run project test suite — must pass before next task

### Task 4: Cache-complete re-query internal to service worker

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/background.test.ts`

- [x] Service worker stores the last `selectionChanged` parameters (labelId, includeChildren, scope) when received
- [x] In the `cacheState` progress callback, when phase is "complete": if a label is active, re-run `cacheManager.queryLabel` with the stored parameters and push updated `labelResult` to the sidepanel. Also push updated `countsReady`.
- [x] Remove `cacheState.phase === "complete"` re-query logic from sidepanel (sidepanel still receives `cacheState` for progress bar display only)
- [x] Add test: cache complete with active label triggers re-query and pushes updated labelResult
- [x] Run project test suite — must pass before next task

### Task 5: Verify acceptance criteria

- [x] Manual test: click a label — Gmail navigates, co-labels shown with counts (skipped - not automatable)
- [x] Manual test: click active label to deselect — Gmail navigates to #all, all labels shown (skipped - not automatable)
- [x] Manual test: change scope with label selected — Gmail re-navigates, counts update (skipped - not automatable)
- [x] Manual test: toggle include-children — re-queries with descendants (skipped - not automatable)
- [x] Manual test: switch to Summary tab — Gmail returns to inbox (filtersOff) (skipped - not automatable)
- [x] Manual test: return to Gmail from another site — selection restored (skipped - not automatable)
- [x] Run full test suite: `npm test`
- [x] Run linter: `npm run lint`

### Task 6: Update documentation

- [x] Update `docs/pages/data-flow.md` — replace queryLabel + applyFilters with selectionChanged in flows
- [x] Update `docs/pages/label-selection-change.mmd` diagram
- [x] Update CLAUDE.md if internal patterns changed
- [x] Move this plan to `docs/plans/completed/`
