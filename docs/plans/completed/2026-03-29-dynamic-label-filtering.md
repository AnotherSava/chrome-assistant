# Dynamic Label Filtering via Message Metadata Cache

## Overview

Filter the Filters tab label tree to only show labels that appear on messages matching the current criteria (location + scope + selected label). Build a persistent local cache of message metadata so filter changes are instant. Progressive loading with dimmed-label UX during targeted fetches.

## Context

- Files involved:
  - Modify: `packages/core/types.ts` — add `MessageMeta` interface
  - Modify: `packages/site-gmail/src/gmail-api.ts` — add `fetchMessagePage`, `buildSearchQuery`
  - Modify: `packages/site-gmail/src/background.ts` — add `fetchMessagePage` handler, refactor `buildGmailUrl`
  - Modify: `packages/site-gmail/src/sidepanel.ts` — cache, progressive loading, local filtering, dimming UX
  - Modify: `packages/core/sidepanel.css` — dimmed labels, progress text styles
- Related patterns: existing `fetchLabels` → `labelsReady` port messaging; `loadSetting`/`saveSetting` for persistence; `buildGmailUrl` query construction
- Dependencies: Gmail API `messages.list` and `messages.get` (format=minimal) — already covered by `gmail.readonly` OAuth scope

## Development Approach

- Testing approach: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Design Notes

**Two fetch modes.** Broad build fetches ALL messages page by page (newest first, no filter) to build a complete cache. Targeted fetch runs when a label is selected beyond the cached range — it fetches only the gap (`after:scopeDate before:cacheOldestDate label:x`) to avoid re-fetching messages already in the broad cache. Targeted fetch pauses the broad build and resumes after completion.

**Per-label coverage tracking.** Each label tracks the oldest cached message timestamp via `labelOldest: Record<string, number>`. When `labelOldest[id] <= scopeTimestamp`, the cache fully covers that label+scope combination — filter locally. Targeted fetch updates the label's entry; broad build updates all labels encountered. This means repeated queries for the same label+scope are instant cache hits.

**Co-occurring labels.** When a label is selected, the visible label set shows labels that appear on messages which ALSO have the selected label (within the location+scope). This helps discover related labels.

**Compact storage format.** A label-to-index mapping converts string label IDs to numbers. Each message is stored as `[internalDate, ...labelIndices]` — a flat number array. ~100KB for 5000 messages vs ~500KB with strings. Persisted to localStorage via `saveSetting`/`loadSetting`.

**Progressive dimming UX.** During a targeted fetch: all labels render dimmed (opacity 0.3) except the selected label (full brightness). As pages arrive, labels found in fetched messages un-dim. Labels already matching from the partial broad cache are un-dimmed immediately. On completion, the list rebuilds showing only relevant labels (recalculated columns, no empty spaces).

**Cache reuse on scope changes.** Narrowing scope: purely local re-filter. Broadening scope: if `cache.complete` or scope within `cache.oldest`, filter locally — no re-fetch. Targeted fetch only when scope extends beyond cache AND a label is selected.

**`buildSearchQuery` extraction.** The query-building logic in `buildGmailUrl` (label escaping, `in:location`, `after:date`) is extracted into a shared `buildSearchQuery(location, labelName, scope, beforeDate?)` function. Used by both `buildGmailUrl` (URL construction) and targeted fetches (API `q` parameter). The optional `beforeDate` parameter supports gap queries.

## Implementation Steps

### Task 1: Add types and API functions

**Files:**
- Modify: `packages/core/types.ts`
- Modify: `packages/site-gmail/src/gmail-api.ts`

- [x] Add `MessageMeta` interface to `packages/core/types.ts`: `{ id: string; labelIds: string[]; internalDate: number }`
- [x] Add `MessagesListResponse` and `MessageMinimalResponse` interfaces to `gmail-api.ts`
- [x] Add `buildSearchQuery(location, labelName, scope, beforeDate?)` function — extract query logic from `buildGmailUrl`
- [x] Add `parallelMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]>` helper for bounded concurrency
- [x] Add `fetchMessagePage(query, pageToken?, concurrency?)` function:
  - Call `GET /messages?maxResults=500&q={query}&pageToken={token}` for message IDs + `resultSizeEstimate`
  - Batch-fetch `GET /messages/{id}?format=minimal` with concurrency 5
  - Return `{ messages: MessageMeta[], nextPageToken: string | null, totalEstimate: number }`
- [x] Export `buildSearchQuery`, `fetchMessagePage`, `MessageMeta`
- [x] Write tests for `buildSearchQuery` (various location/label/scope/beforeDate combinations)
- [x] Run project test suite — must pass before next task

### Task 2: Add background message handler

**Files:**
- Modify: `packages/site-gmail/src/background.ts`

- [x] Import `fetchMessagePage` and `buildSearchQuery` from `gmail-api.ts`
- [x] Refactor `buildGmailUrl` to use `buildSearchQuery` internally (same behavior, shared logic)
- [x] Add `fetchMessagePage` port message handler:
  - Request: `{ type: "fetchMessagePage", query: string, pageToken?: string, fetchId: string }`
  - Calls `fetchMessagePage(query, pageToken)` from gmail-api
  - Response: `{ type: "messagePageReady", messages: MessageMeta[], nextPageToken: string | null, totalEstimate: number, fetchId: string }`
  - Error: `{ type: "messagePageError", fetchId: string }`
  - `fetchId` echoed back for broad vs targeted disambiguation
- [x] Update port message type union to include new fields
- [x] Write tests for refactored `buildGmailUrl` (ensure same behavior)
- [x] Run project test suite — must pass before next task

### Task 3: Add compact message cache to sidepanel

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`

- [x] Define compact cache structure and persistence keys:
  - `ca_msg_cache_labels`: `string[]` (index→labelId map)
  - `ca_msg_cache_messages`: `number[][]` (`[internalDate, ...labelIndices]`)
  - `ca_msg_cache_oldest`: `number | null` (broad build progress)
  - `ca_msg_cache_complete`: `boolean`
  - `ca_msg_cache_label_oldest`: `Record<string, number>` (per-label coverage)
- [x] Add `MsgCache` interface and state variables: `msgCache`, `msgCacheIds: Set<string>` (dedup, not persisted)
- [x] Add `loadMsgCache()` — loads from localStorage, rebuilds `msgCacheIds` set
- [x] Add `saveMsgCache()` — persists compact form to localStorage
- [x] Add `mergeMessages(newMessages: MessageMeta[])` — dedup by ID, convert to compact form, update `msgCache.oldest` and `msgCache.labelOldest` for all labels encountered
- [x] Add `scopeToTimestamp()` — like `scopeToDate()` but returns epoch ms (for local filtering)
- [x] Write tests for `mergeMessages` (dedup, label indexing, oldest tracking)
- [x] Run project test suite — must pass before next task

### Task 4: Add local filtering functions

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`

- [x] Add `filterMessages(location, scopeTimestamp, labelId)` — filters compact `number[][]` arrays:
  - location "inbox" → must have INBOX index; "sent" → SENT index; "all" → no location filter
  - scope → `message[0] >= scopeTimestamp`
  - labelId → must have that label's index (co-occurring mode)
- [x] Add `deriveRelevantLabelIds(filtered)` → `Set<string>` via label index map
- [x] Add `addParentChain(relevantIds, allLabels)` — for tree integrity, add labels whose name is a prefix of a relevant label
- [x] Add `isCacheCovering(labelId, scopeTimestamp)` — checks if cache covers query:
  - No label: `cache.complete || scopeTimestamp >= cache.oldest`
  - With label: `cache.complete || labelOldest[labelId] <= scopeTimestamp`
- [x] Add `renderFilteredLabels()` — the main orchestrator:
  - If `dimmedMode`: render all labels with dimmed class, un-dim `relevantLabelIds` + selected
  - If cache covers scope: filter → derive IDs → filter `cachedLabels` → `renderLabels(filtered)`
  - If not covered and no label selected: show all labels
  - If not covered and label selected: trigger targeted fetch
  - Selected label + parent chain always visible
- [x] Write tests for `filterMessages`, `deriveRelevantLabelIds`, `addParentChain`, `isCacheCovering`
- [x] Run project test suite — must pass before next task

### Task 5: Wire up progressive broad cache build

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`

- [x] Add broad build state: `broadFetchId`, `broadPageToken`, `broadPaused`
- [x] Add `startBroadBuild()` — generates fetchId, sends first `fetchMessagePage` with empty query
- [x] Add `continueBroadBuild(nextPageToken)` — requests next page if not paused
- [x] Modify `handleMessage` to handle `messagePageReady`:
  - Match by `fetchId` (broad vs targeted)
  - For broad: merge messages, persist, update progress, re-render filtered labels, request next page
  - When `nextPageToken` is null: mark `cache.complete`, persist
- [x] Handle `messagePageError`: stop loading, fall back to showing all labels
- [x] Trigger broad build on `resultsReady` (parallel with `loadLabels`)
- [x] On subsequent opens: load persisted cache, start incremental refresh (messages newer than newest cached)
- [x] Add progress display: "Caching message labels: loaded to Mar 15, 2024" in filter bar area
- [x] Write tests for broad build state transitions
- [x] Run project test suite — must pass before next task

### Task 6: Wire up targeted fetch with dimming UX

**Files:**
- Modify: `packages/site-gmail/src/sidepanel.ts`
- Modify: `packages/core/sidepanel.css`

- [x] Add targeted state: `targetedFetchId`, `targetedInProgress`, `dimmedMode`, `relevantLabelIds: Set<string>`
- [x] Add `startTargetedFetch(labelId, labelName)`:
  - Pause broad build
  - Build gap query: `buildSearchQuery(location, labelName, scope, beforeDate)` where `beforeDate` from `cache.oldest`
  - Generate fetchId, set `dimmedMode = true`
  - Compute initial `relevantLabelIds` from whatever cache already has
  - Render dimmed labels
  - Send `fetchMessagePage` with gap query
- [x] Modify `handleMessage` `messagePageReady` for targeted:
  - Merge into cache, expand `relevantLabelIds`, un-dim newly found labels
  - Show progress: "Fetching labels from target messages: Jun 15, 2024"
  - Request next page if token exists
  - On complete: update `labelOldest`, set `dimmedMode = false`, rebuild label list (only relevant labels, recalculate columns), resume broad build
- [x] Add CSS: `.label-link.dimmed { opacity: 0.3; }`, `.cache-progress { font-size: 11px; color: #888; }`
- [x] Modify filter change triggers (Location, Scope, Label click) to:
  - Clear stale targeted state
  - Call `renderFilteredLabels()` (instant if cached, or triggers targeted fetch)
  - Call `applyFilters()` (Gmail navigation)
- [x] Write tests for targeted fetch state transitions, dimming logic
- [x] Run project test suite — must pass before next task

### Task 7: Verify acceptance criteria

- [x] Manual test: first open — progress shows as cache builds, labels filter progressively (skipped - not automatable)
- [x] Manual test: close mid-load, reopen — resumes from persisted cache (skipped - not automatable)
- [x] Manual test: change Location within cached range — instant label update (skipped - not automatable)
- [x] Manual test: change Scope within cached range — instant label update (skipped - not automatable)
- [x] Manual test: select label beyond cache range — dimmed mode, labels un-dim progressively (skipped - not automatable)
- [x] Manual test: select same label again — instant (per-label coverage cached) (skipped - not automatable)
- [x] Manual test: deselect label — labels expand back to location+scope set (skipped - not automatable)
- [x] Manual test: subsequent opens — instant from persisted cache + incremental refresh (skipped - not automatable)
- [x] Run full test suite: `npm test`
- [x] Run linter: `npm run lint`

### Task 8: Update documentation

- [x] Update `README.md` — mention dynamic label filtering feature
- [x] Update `CLAUDE.md` — add message cache to Project Structure section
- [x] Update help page (`packages/site-gmail/src/help.ts`) — describe label filtering behavior
- [x] Move this plan to `docs/plans/completed/`
