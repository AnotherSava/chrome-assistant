# Include Children Labels in Parent Query

## Overview

When a user selects a parent label (e.g. "Games"), only messages directly tagged with "Games" are counted and shown. Messages tagged with sub-labels like "Games/18xx" or "Games/Chess" are excluded. This plan adds a persistent "Include sub-labels" checkbox in the display settings panel. When enabled, clicking a parent label queries all its descendants too, showing combined message counts, co-labels, and Gmail search results.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/sidepanel.ts` — add setting, resolve descendant IDs, send array, adjust Gmail query
  - Modify: `packages/site-gmail/src/cache-manager.ts` — accept label ID array in queryLabel, union messages
  - Modify: `packages/site-gmail/src/background.ts` — relay labelIds array from sidepanel to cache-manager
  - Modify: `packages/site-gmail/src/gmail-api.ts` — buildSearchQuery to support OR-combined label queries
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — tests for multi-label queryLabel
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — tests for setting and descendant resolution
- Related patterns: `buildLabelTree` already builds parent/child relationships; `sendQueryLabel` sends query to background; `queryLabel` in cache-manager queries IndexedDB
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Sidepanel resolves descendants, not cache-manager.** The sidepanel already has the label tree built via `buildLabelTree`. When "include sub-labels" is enabled and the user clicks a label, the sidepanel walks the tree to collect all descendant label IDs and sends the full array to the background. This keeps the cache-manager simple — it just unions messages from whatever IDs it receives.

**queryLabel accepts an array.** The cache-manager's `queryLabel` signature changes from `(labelId: string, ...)` to `(labelIds: string[], ...)`. It fetches messages for each label ID from IndexedDB, deduplicates by message ID, applies location/scope filters on the union, and returns count + co-labels. Co-labels are derived from the messages in the union as usual — only the primary label ID (first in the array) is excluded. Sub-label IDs are NOT excluded: they appear as co-labels if any matched messages carry them, and don't appear if no messages have them. The `prioritizeLabel` fallback also loops over all IDs.

**Gmail search uses OR syntax.** `buildSearchQuery` currently produces `label:"games" in:inbox`. With sub-labels, it produces `{label:"games" OR label:"games-18xx" OR label:"games-chess"} in:inbox`. Gmail supports `{...}` grouping with OR for this purpose.

**Active highlight stays on the clicked label only.** Child labels appear in the filtered list (as co-labels from the combined query) but without the `.active` class.

**Leaf labels are unaffected.** When a label has no sub-labels in the tree, the array contains just the single ID — same behavior as before.

**Setting key:** `ca_include_children`, default `true`, persisted via `saveSetting`/`loadSetting`.

## Implementation Steps

### Task 1: Extend queryLabel to accept multiple label IDs

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Change `queryLabel` signature from `(labelId: string, location, scopeTimestamp)` to `(labelIds: string[], location, scopeTimestamp)`. Fetch messages for each ID via `getMessagesByLabel`, deduplicate by message ID, then apply existing location/scope filters on the union. Exclude only the primary label ID (first in array) from co-labels — sub-label IDs appear naturally if matched messages carry them.
- [x] Update `prioritizeLabel` call inside `queryLabel` to loop over all IDs that aren't already processed.
- [x] Update `scopeFallback` to handle multiple label IDs — fetch scoped IDs for each, union them, then cross-reference.
- [x] Update background.ts `queryLabel` message handler to pass `message.labelIds` (array) instead of `message.labelId` (string). Keep backward compat: if `labelIds` is absent, fall back to `[message.labelId]`.
- [x] Add test: queryLabel with multiple label IDs returns union count and combined co-labels
- [x] Add test: queryLabel with multiple label IDs excludes only primary ID from co-labels, sub-label IDs appear if messages have them
- [x] Add test: queryLabel with multiple IDs + location filter works correctly
- [x] Run project test suite — must pass before next task

### Task 2: Add display setting and descendant resolution in sidepanel

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Add `ca_include_children` setting (boolean, default true), loaded on startup
- [x] Add checkbox to `buildDisplayPanel` after the "Return to Inbox" checkbox: "Include sub-labels when selecting a parent"
- [x] Add helper `getDescendantIds(labelId: string): string[]` that walks the cached label tree (from `buildLabelTree`) to collect all descendant label IDs. Returns empty array for leaf labels.
- [x] Update `sendQueryLabel` to resolve descendants when setting is enabled: if `includeChildren` is true and the active label has sub-labels, send `labelIds: [activeLabelId, ...descendantIds]`; otherwise send `labelIds: [activeLabelId]`
- [x] Update `renderFilteredLabels` to exclude all queried label IDs from active highlighting (only `activeLabelId` gets `.active` class — this is already the case, just verify)
- [x] Add test: getDescendantIds returns all descendants for a nested label
- [x] Add test: getDescendantIds returns empty for leaf label
- [x] Add test: sendQueryLabel sends array with descendants when setting is on
- [x] Add test: sendQueryLabel sends single-element array when setting is off
- [x] Run project test suite — must pass before next task

### Task 3: Update Gmail search query for multiple labels

**Files:**
- Modify: `packages/site-gmail/src/gmail-api.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/gmail-api.test.ts`

- [x] Update `buildSearchQuery` to accept `labelName: string | string[]`. When given an array with more than one entry, produce `{label:"a" OR label:"b" OR label:"c"}` using Gmail's grouping syntax. Single entry behaves as before.
- [x] Update `applyFilters` in sidepanel to pass the array of label names (active + descendants) when `includeChildren` is enabled
- [x] Add test: buildSearchQuery with single label produces current format
- [x] Add test: buildSearchQuery with multiple labels produces `{...OR...}` format
- [x] Add test: buildSearchQuery with multiple labels + location + scope combines correctly
- [x] Run project test suite — must pass before next task

### Task 4: Verify acceptance criteria

- [ ] Manual test: enable "Include sub-labels", select parent label — count shows messages from all sub-labels
- [ ] Manual test: Gmail navigates to OR-combined search showing all sub-labels' messages
- [ ] Manual test: co-labels shown include sub-labels (not highlighted), plus other labels on those messages
- [ ] Manual test: disable setting — behavior returns to single-label query
- [ ] Manual test: leaf label with setting enabled behaves identically to disabled
- [ ] Run full test suite: `npm test`
- [ ] Run linter: `npm run lint`

### Task 5: Update documentation

- [ ] Update CLAUDE.md if internal patterns changed
- [ ] Move this plan to `docs/plans/completed/`
