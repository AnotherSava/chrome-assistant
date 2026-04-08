# Hide Labels with Zero Count When Scope is Active

## Overview

When a scope filter is active and no label is selected, hide labels that have zero messages in the current scope. This is implemented in the cache manager: `getLabelCounts` omits entries with zero count when a scope timestamp is set, consistent with how `queryLabel` omits zero-count co-labels. The sidepanel filters `cachedLabels` to those present in `labelCounts`, using the same pattern as co-label filtering.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/cache-manager.ts` — omit zero-count entries from `getLabelCounts` when scope is active
  - Modify: `packages/site-gmail/src/sidepanel.ts` — filter `cachedLabels` by presence in `labelCounts` when no label is selected
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — tests for zero-count omission
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — tests for label hiding
- Related patterns: `queryLabel` naturally omits zero-count co-labels from `coLabelCounts`; `renderFilteredLabels` already filters by co-label presence when a label is selected; `addParentChain` preserves tree structure for visible labels
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Cache manager omits zero-count entries.** `getLabelCounts` skips labels with zero count when `scopeTimestamp` is not null, same as `queryLabel` naturally excludes zero-count co-labels. When scope is null ("any"), all entries are included regardless of count. This keeps the filtering policy in the data layer, consistent with the co-label pattern.

**Sidepanel filters by presence in `labelCounts`.** In `renderFilteredLabels`, when no label is selected and `labelCounts` is available: filter `cachedLabels` to those present in `labelCounts`. Labels absent from `labelCounts` (zero count, omitted by cache manager) are hidden. This parallels the co-label path where labels absent from `coLabelCounts` are hidden.

**Parent labels stay visible if any child is visible.** After filtering to labels present in `labelCounts`, run `addParentChain` on the surviving IDs so parent labels needed for tree nesting remain visible. A parent with own=0 but a child with count>0 stays visible because the child is in `labelCounts`, and `addParentChain` adds the parent.

**When scope is "any", all labels shown.** No filtering — `getLabelCounts` includes all entries, sidepanel renders all `cachedLabels`.

**Labels not yet cached are still shown.** Labels absent from `labelCounts` because they haven't been cached yet (no `labelIdx:*` entry) are treated as "no data" not "zero count". Since the cache manager only omits entries it computed as zero (not entries it never computed), uncached labels won't have an entry at all and should still be shown. The filtering should only apply when `labelCounts` is populated.

## Implementation Steps

### Task 1: Omit zero-count entries in getLabelCounts

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] In `getLabelCounts`, when `scopeTimestamp` is not null: skip adding entries to `result` where both `own` and `inclusive` are 0. When `scopeTimestamp` is null, include all entries as before.
- [x] Add test: getLabelCounts with scope omits labels with own=0 and inclusive=0
- [x] Add test: getLabelCounts with scope keeps labels with own=0 but inclusive>0
- [x] Add test: getLabelCounts without scope includes labels with own=0
- [x] Run project test suite — must pass before next task

### Task 2: Filter rendered labels by presence in labelCounts

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] In `renderFilteredLabels`, when no label is selected and `labelCounts` is available and `scopeValue !== "any"`: filter `cachedLabels` to only those with an entry in `labelCounts`. Run `addParentChain` on the surviving IDs to preserve tree structure. Fall back to showing all labels if the filtered set is empty.
- [x] Add test: with scope active, labels absent from labelCounts are hidden
- [x] Add test: parent label present in labelCounts (inclusive>0) stays visible
- [x] Add test: with scope "any", all labels shown regardless of labelCounts
- [x] Run project test suite — must pass before next task

### Task 3: Verify acceptance criteria

- [x] Manual test: set scope to 1 month — labels with no recent emails disappear (skipped - not automatable)
- [x] Manual test: set scope back to "any" — all labels reappear (skipped - not automatable)
- [x] Manual test: parent label with children that have recent emails stays visible (skipped - not automatable)
- [x] Manual test: parent label where no children have recent emails disappears (skipped - not automatable)
- [x] Manual test: select a label — co-label filtering still works as before (skipped - not automatable)
- [x] Run full test suite: `npm test` — 160 tests pass
- [x] Run linter: `npm run lint` — clean

### Task 4: Update documentation

- [x] Update CLAUDE.md if internal patterns changed (no changes needed - existing descriptions are accurate)
- [x] Move this plan to `docs/plans/completed/`
