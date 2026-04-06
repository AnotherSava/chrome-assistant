# Show Email Counts Per Label

## Overview

Display message counts next to each label in the side panel. When no label is selected, each label shows its total message count (own or inclusive depending on the include-children setting). When a label is selected, co-labels show how many of the filtered messages contain that particular co-label. Counts respect the active location and scope filters. Parent label inclusive counts are computed with proper deduplication by the cache manager.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/cache-manager.ts` — add `getLabelCounts()` method returning own + inclusive counts
  - Modify: `packages/site-gmail/src/cache-db.ts` — add helper to scan messages once and return per-label counts with location/scope filtering
  - Modify: `packages/site-gmail/src/background.ts` — include counts in `labelsReady` response, pass location/scope to count computation
  - Modify: `packages/site-gmail/src/sidepanel.ts` — render counts in label tree, pick own vs inclusive, request updated counts on filter change
  - Modify: `packages/core/src/sidepanel.css` — style for muted count display
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — tests for getLabelCounts
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — tests for count rendering
- Related patterns: `labelIdx:*` meta entries store message IDs per label; `queryLabel` already iterates messages and collects co-labels; `buildLabelTree` / `getDescendantIds` handle parent/child hierarchy
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Own vs inclusive counts.** Each label has two counts: own (messages directly tagged with this label) and inclusive (own + all descendants, deduplicated). The cache manager computes both. The sidepanel picks which to display based on the include-children setting. Leaf labels have identical own and inclusive counts.

**Descendant detection via prefix matching.** The cache manager uses `label.name.startsWith(parentName + "/")` to find descendants — no tree structure needed. This is consistent with how `getDescendantIds` works in the sidepanel.

**Counts respect location/scope filters.** When location is "inbox" or "sent", only messages with the corresponding system label are counted. When a scope timestamp is set, only messages with `internalDate >= scopeTimestamp` are counted. This requires reading actual message records, not just index sizes.

**Single-pass counting.** For efficiency, `getLabelCounts` reads all relevant message IDs from label indexes, batch-fetches their records, then counts per-label in one pass. For inclusive counts of parent labels, it unions parent + descendant index entries, deduplicates, and counts filtered messages.

**Co-label counts in queryLabel.** `LabelQueryResult.coLabels` changes from `string[]` to `Record<string, number>` — a map of co-label ID to the number of filtered messages carrying that label. The existing message iteration in `queryLabel` already visits every message; it just increments a counter per label instead of adding to a Set.

**Show counts setting.** A "Show email counts" checkbox in the display settings panel controls whether counts are visible. Setting key: `ca_show_counts`, default `true`, persisted via `saveSetting`/`loadSetting`. When disabled, no counts are rendered and no count requests are sent to the background (avoids unnecessary computation).

**Count styling.** Counts appear after the label name in parentheses, styled with a muted/darker color to blend with the background rather than competing with the label name.

**Requesting counts on filter change.** The sidepanel sends location and scope with the `fetchLabels` request. The background passes these to `getLabelCounts()` and includes the result in `labelsReady`. When location or scope changes, the sidepanel re-requests labels to get updated counts. Counts are only requested when the show-counts setting is enabled.

## Implementation Steps

### Task 1: Add getLabelCounts to cache manager

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/cache-db.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Add `getFilteredLabelCounts(labelIds: string[], location: string | undefined, scopeTimestamp: number | null): Promise<Record<string, number>>` to cache-db — given a list of label IDs, reads their `labelIdx:*` entries, batch-fetches message records, filters by location/scope, and returns per-label message count
- [x] Add `getLabelCounts(location: string | undefined, scopeTimestamp: number | null): Promise<Record<string, { own: number; inclusive: number }>>` to cache manager — uses `this.labels` to identify all labels, calls `getFilteredLabelCounts` for own counts, then computes inclusive counts by unioning parent + descendant indexes (found via `startsWith` prefix matching) and counting filtered messages
- [x] Add test: getLabelCounts returns correct own counts per label
- [x] Add test: getLabelCounts returns correct inclusive counts for parent labels (deduplicated)
- [x] Add test: getLabelCounts filters by location
- [x] Add test: getLabelCounts filters by scope timestamp
- [x] Run project test suite — must pass before next task

### Task 2: Change coLabels to coLabelCounts in queryLabel

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Change `LabelQueryResult.coLabels` from `string[]` to `coLabelCounts: Record<string, number>`. In `queryLabel`, replace the `coLabelSet` Set with a counter map — for each message, increment the count for each of its label IDs (excluding the primary label)
- [x] Update `scopeFallback` to return `coLabelCounts` instead of `coLabels`
- [x] Update background.ts `labelResult` relay to pass `coLabelCounts`
- [x] Update sidepanel.ts `handleMessage` for `labelResult` — use `Object.keys(coLabelCounts)` where it previously used `coLabels` for filtering, store the counts for rendering
- [x] Update `renderFilteredLabels` to use `coLabelCounts` keys instead of `coLabels`
- [x] Update all tests referencing `coLabels` to use `coLabelCounts`
- [x] Run project test suite — must pass before next task

### Task 3: Include counts in labelsReady and render them

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/core/src/sidepanel.css`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Add `ca_show_counts` setting (boolean, default true), loaded on startup. Add "Show email counts" checkbox to `buildDisplayPanel`. Export a `setShowCounts` setter for testing.
- [x] Update `fetchLabels` message handler in background.ts to accept `location` and `scopeTimestamp` parameters. After fetching labels, call `cacheManager.getLabelCounts(location, scopeTimestamp)` and include the result as `counts` in the `labelsReady` response
- [x] Update sidepanel.ts `loadLabels` to send location and scope with the `fetchLabels` request (only when show-counts is enabled)
- [x] Store `labelCounts` from `labelsReady` in sidepanel state
- [x] Update `renderLabelTree` to append count after label name when show-counts is enabled — use own or inclusive count based on include-children setting. When a label is selected, use `coLabelCounts` from `lastLabelResult` instead. Display as `Label (42)` with the count in a `<span class="label-count">` element
- [x] When location or scope changes, re-request labels to get updated counts (only when show-counts is enabled)
- [x] When show-counts is toggled on, re-request labels to fetch counts; when toggled off, re-render to hide counts
- [x] Add CSS for `.label-count` — muted color, slightly smaller or same size, blends with background
- [x] Add test: renderLabelTree includes count spans
- [x] Add test: counts update when location/scope changes
- [x] Run project test suite — must pass before next task

### Task 4: Verify acceptance criteria

- [x] Manual test: no label selected — each label shows its message count (skipped - not automatable)
- [x] Manual test: toggle include-children — parent label counts change between own and inclusive (skipped - not automatable)
- [x] Manual test: change location to Sent — counts update to reflect only sent messages (skipped - not automatable)
- [x] Manual test: change scope to 1 month — counts update (skipped - not automatable)
- [x] Manual test: select a label — co-labels show filtered counts (how many of the selected label's messages have each co-label) (skipped - not automatable)
- [x] Manual test: count styling is muted, doesn't distract from label names (skipped - not automatable)
- [x] Run full test suite: `npm test`
- [x] Run linter: `npm run lint`

### Task 5: Update documentation

- [x] Update CLAUDE.md if internal patterns changed
- [x] Move this plan to `docs/plans/completed/`
