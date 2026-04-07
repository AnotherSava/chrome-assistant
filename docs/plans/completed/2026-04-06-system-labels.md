# Show System Labels as Regular Labels

## Overview

Remove the Location dropdown filter and instead show system labels (INBOX, SENT, STARRED, IMPORTANT) as clickable labels in the side panel. They behave like any other label — clicking one selects it, shows co-labels, shows count. INBOX and SENT are always cached. STARRED and IMPORTANT are cached only when their respective display setting checkboxes are enabled (default off). System labels appear before user labels in the label list, and follow the same co-label visibility rules as user labels.

## Context

- Files involved:
  - Modify: `packages/site-gmail/src/sidepanel.ts` — remove location dropdown, remove locationValue/KEY_LOCATION/LOCATION_OPTIONS, add STARRED/IMPORTANT display settings, show system labels in label tree before user labels
  - Modify: `packages/site-gmail/src/cache-manager.ts` — remove location parameter from queryLabel/getLabelCounts/scopeFallback, conditionally cache STARRED/IMPORTANT, update buildLabelQueryList
  - Modify: `packages/site-gmail/src/cache-db.ts` — remove location parameter from getFilteredLabelCounts
  - Modify: `packages/site-gmail/src/background.ts` — remove location from message handling, pass STARRED/IMPORTANT settings to cache manager, update buildGmailUrl for system label navigation
  - Modify: `packages/site-gmail/src/gmail-api.ts` — remove location from buildSearchQuery
  - Modify: `packages/core/src/sidepanel.css` — style for system labels if needed
  - Modify: `packages/site-gmail/tests/cache-manager.test.ts` — remove location from queryLabel/getLabelCounts tests
  - Modify: `packages/site-gmail/tests/sidepanel.test.ts` — remove location tests, add system label visibility tests
  - Modify: `packages/site-gmail/tests/background.test.ts` — update for removed location
  - Modify: `packages/site-gmail/tests/gmail-api.test.ts` — update buildSearchQuery tests
- Related patterns: `LABELS_HIDDEN` controls which system labels are hidden from the label tree; `SYSTEM_LABELS_TO_QUERY` controls which are cached; `buildLabelTree` sorts and nests labels; `renderFilteredLabels` filters by co-labels
- Dependencies: none

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**System labels are just labels.** No special intersection or persistent filter logic. Clicking INBOX selects it like clicking any user label — shows INBOX count, co-labels, and navigates Gmail. Clicking a user label deselects INBOX (only one label selected at a time). The only difference is Gmail search syntax: system labels use `in:inbox`/`in:sent`/`in:starred`/`in:important` instead of `label:...`.

**Visibility follows co-label rules.** When no label is selected, all labels (system + user) are shown. When a label is selected, only co-labels are shown — system labels appear only if at least one message in the selection has them. This is already how `renderFilteredLabels` works; system labels just need to not be hidden.

**LABELS_HIDDEN changes.** Remove INBOX, SENT, STARRED, IMPORTANT from `LABELS_HIDDEN`. Keep the rest (CHAT, DRAFT, SPAM, TRASH, UNREAD, CATEGORY_*, star colors).

**System labels rendered before user labels.** In `buildLabelTree`, system labels (INBOX, SENT, STARRED, IMPORTANT) are placed before user labels. They are flat (no nesting).

**Gmail navigation for system labels.** When a system label is clicked without a scope filter, navigate directly: `#inbox`, `#sent`, `#starred`, `#imp`. When a scope filter is active, use search: `#search/in:inbox after:DATE`. This is handled in `buildSearchQuery` — system labels use `in:` prefix instead of `label:`, and `buildGmailUrl` uses direct hash navigation only when the query is a simple `in:` clause with no other filters.

**STARRED/IMPORTANT caching is conditional.** Display settings checkboxes `ca_show_starred` (default false) and `ca_show_important` (default false) control whether STARRED and IMPORTANT are included in `SYSTEM_LABELS_TO_QUERY`. When toggled on after the cache has already completed, `prioritizeLabel` fetches just that single label on-demand — no full cache rebuild. When toggled off, their data stays in IndexedDB but they're excluded from the label list via `LABELS_HIDDEN`.

**Location parameter removed everywhere.** The `location` parameter is deleted from: `queryLabel`, `getLabelCounts`, `getFilteredLabelCounts`, `applyFilters`, `sendQueryLabel`, `requestCounts`, `fetchCounts` message, `applyFilters` message, `buildGmailUrl`. In `buildSearchQuery`, the `location` parameter is replaced by detecting system label names — system labels produce `in:inbox`/`in:sent`/`in:starred`/`in:important` while user labels produce `label:...` as before.

**Return-to-inbox unchanged.** The return-to-inbox behavior (navigating Gmail back to inbox when switching from Filters to Summary tab) stays the same. With location removed, it simply hardcodes `#inbox` instead of using the location setting.

## Implementation Steps

### Task 1: Remove location parameter from cache layer

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/cache-db.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Remove `location` parameter from `queryLabel` — delete the `locationLabelId` mapping and `labelIds.includes(locationLabelId)` filter
- [x] Remove `location` parameter from `getLabelCounts` — pass through to `getFilteredLabelCounts` without it
- [x] Remove `location` parameter from `getFilteredLabelCounts` in cache-db — delete the `locationLabelId` filtering logic
- [x] Remove `location` parameter from `scopeFallback`
- [x] Update all tests that pass `location` to these functions — remove the parameter, update expected results
- [x] Run project test suite — must pass before next task

### Task 2: Remove location from messaging and Gmail navigation

**Files:**
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/src/gmail-api.ts`
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/background.test.ts`
- Modify: `packages/site-gmail/tests/gmail-api.test.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Update `buildSearchQuery` in gmail-api.ts — remove `location` parameter, detect system label names and use `in:inbox`/`in:sent`/`in:starred`/`in:important` instead of `label:...` for them
- [x] Update `buildGmailUrl` in background.ts — remove location parameter, use direct hash navigation (`#inbox`, `#sent`, `#starred`, `#imp`) when the query is a simple `in:` clause with no other filters
- [x] Remove `location` from `applyFilters` message in sidepanel.ts and background.ts handler
- [x] Remove `location` from `queryLabel` message in sidepanel.ts (`sendQueryLabel`) and background.ts handler
- [x] Remove `location` from `fetchCounts` message in sidepanel.ts (`requestCounts`) and background.ts handler
- [x] Remove `locationValue`, `KEY_LOCATION`, `LOCATION_OPTIONS` from sidepanel.ts
- [x] Remove location dropdown from `renderFilterBar` and `setupFilterBar`
- [x] Update `resetGmailToInbox` to use hardcoded `#inbox` navigation instead of location-based
- [x] Update all affected tests
- [x] Run project test suite — must pass before next task

### Task 3: Show system labels in label tree

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/site-gmail/tests/sidepanel.test.ts`

- [x] Remove INBOX, SENT, STARRED, IMPORTANT from `LABELS_HIDDEN`
- [x] Update `buildLabelTree` to place system labels (INBOX, SENT, and optionally STARRED, IMPORTANT) before user labels — sort system labels in a fixed order (INBOX, SENT, STARRED, IMPORTANT), then user labels alphabetically as before
- [x] Add `ca_show_starred` and `ca_show_important` settings (boolean, default false), loaded on startup
- [x] Add "Show Starred" and "Show Important" checkboxes to `buildDisplayPanel`
- [x] When a show-starred/show-important checkbox is toggled, add/remove the label from `LABELS_HIDDEN` dynamically and re-render. Also notify background to update caching (see Task 4).
- [x] Add test: system labels appear before user labels when visible
- [x] Add test: STARRED/IMPORTANT hidden when settings are off
- [x] Add test: STARRED/IMPORTANT visible when settings are on and co-label rules allow
- [x] Run project test suite — must pass before next task

### Task 4: Conditional caching of STARRED and IMPORTANT

**Files:**
- Modify: `packages/site-gmail/src/cache-manager.ts`
- Modify: `packages/site-gmail/src/background.ts`
- Modify: `packages/site-gmail/tests/cache-manager.test.ts`

- [x] Make `SYSTEM_LABELS_TO_QUERY` dynamic — always include INBOX and SENT, conditionally include STARRED and IMPORTANT based on settings passed from the sidepanel
- [x] Add a `syncSettings` message from sidepanel to background that passes `showStarred` and `showImportant` flags. Background stores them and passes to cache manager's `buildLabelQueryList`.
- [x] When a show-starred/show-important checkbox is toggled on, use `prioritizeLabel` to fetch just that label on-demand (no full cache rebuild)
- [x] Add test: buildLabelQueryList includes STARRED when setting is on
- [x] Add test: buildLabelQueryList excludes STARRED when setting is off
- [x] Run project test suite — must pass before next task

### Task 5: Verify acceptance criteria

- [x] Manual test: no label selected — all labels shown (system before user), with counts (skipped - not automatable)
- [x] Manual test: click INBOX — navigates Gmail to #inbox, shows co-labels with counts (skipped - not automatable)
- [x] Manual test: click a user label — navigates Gmail to search, system labels appear as co-labels if relevant (skipped - not automatable)
- [x] Manual test: enable Show Starred — STARRED appears in label list after cache fetches it (skipped - not automatable)
- [x] Manual test: disable Show Starred — STARRED disappears from label list (skipped - not automatable)
- [x] Manual test: scope filter still works with system labels (skipped - not automatable)
- [x] Run full test suite: `npm test` — 141 tests passing
- [x] Run linter: `npm run lint` — clean

### Task 6: Update documentation

- [x] Update README.md if user-facing behavior changed (no project README exists - skipped)
- [x] Update CLAUDE.md if internal patterns changed (descriptions still accurate - no changes needed)
- [x] Move this plan to `docs/plans/completed/`
