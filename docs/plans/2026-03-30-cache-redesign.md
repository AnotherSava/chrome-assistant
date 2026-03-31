# Cache Redesign: Label-Query-Based Fetch with Background IndexedDB

## Overview
Replace the current broad build + targeted fetch caching system with a label-query-based approach. The current system makes ~97,700 API calls (one `messages.list` paginated + individual `messages.get` for each of ~92K messages). The new system queries each label separately via `messages.list q=label:X` to build a message-to-labels cross-reference, then batch-fetches `internalDate` via Gmail batch API (100/request). This reduces total API calls to ~1,500 and eliminates the backfill gap bug caused by targeted fetches shifting the `broadOldest` boundary.

The cache becomes a self-contained module running in the background service worker, using IndexedDB for storage. The sidepanel only queries the cache for data and subscribes to progress updates.

### Key benefits
- ~65x fewer API calls (minutes → seconds for initial load)
- No more "invisible messages" — every label is explicitly queried
- No backfill gap bug — no broad build / targeted fetch interaction
- Cache survives panel close (background SW prefetches)
- IndexedDB handles 92K+ records efficiently with per-record access

## Context
- **Files replaced**: `packages/site-gmail/src/msg-cache.ts` (complete rewrite), major changes to `sidepanel.ts` and `background.ts`
- **Files modified**: `packages/site-gmail/src/gmail-api.ts` (add batch API, label query helpers), `packages/core/src/types.ts` (cache types)
- **New files**: `packages/site-gmail/src/cache-db.ts` (IndexedDB layer), `packages/site-gmail/src/cache-manager.ts` (self-contained cache module)
- **Existing patterns**: port messaging between sidepanel/background, `chrome.identity` for auth tokens

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change

## Testing Strategy
- **Unit tests**: required for every task — mock IndexedDB, mock Gmail API responses
- **Integration-style tests**: test cache-manager end-to-end with mocked API layer

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with + prefix
- Document issues/blockers with !! prefix
- Update plan if implementation deviates from original scope

## Architecture

### Data Flow
```
Background Service Worker:
  cache-manager.ts (orchestrator, auto-starts on Gmail tab detection)
    ├── gmail-api.ts (API calls: label queries, batch date fetch)
    └── cache-db.ts (IndexedDB: messages, labels, metadata)
    └── pushes cacheState updates to connected sidepanel ports

Sidepanel:
  sidepanel.ts
    ├── port.onMessage({ type: "cacheState", ... })   ← background (pushed)
    ├── port.postMessage({ type: "queryLabel", ... })  → background
    └── renders labels, progress, counts from cache state
```

### IndexedDB Schema
```
Database: "gmail-cache"

Object Store: "messages"
  keyPath: "id" (Gmail message ID)
  indexes: [internalDate]
  record: { id, internalDate: number | null, labelIds: string[] }

Object Store: "meta"
  keyPath: "key"
  records:
    { key: "account", value: "/mail/u/0/" }
    { key: "fetchState", value: { phase, progress, labelsFetched, datesFetched } }
    { key: "labelCoverage", value: { [labelId]: { complete: boolean, scope: number | null } } }
```

### Fetch Phases
1. **Label queries**: For each label (user + system), `messages.list q=label:X` paginated. Cross-reference builds message→labels map. Store in IndexedDB as `{ id, labelIds, internalDate: null }`.
2. **Batch date fetch**: For messages with `internalDate === null`, batch-fetch via Gmail batch API (100/request). Update IndexedDB records with dates.
3. **Scope fallback**: If user selects a scope and dates aren't cached yet, run `messages.list q=label:X after:DATE` as a fast substitute to get the scoped count.

### Cache Manager API (exposed via port messaging)
```typescript
// Cache auto-starts when background detects Gmail tab (no explicit startCache needed)

// Requests (sidepanel → background)
{ type: "queryLabel", labelId, location, scope }  // Get count + co-occurring labels

// Pushed updates (background → sidepanel, automatic)
{ type: "cacheState", phase, progress, labels, complete }
{ type: "labelResult", labelId, count, coLabels }
```

## Implementation Steps

### Task 1: IndexedDB storage layer (`cache-db.ts`)
- [x] Create `packages/site-gmail/src/cache-db.ts` with IndexedDB open/upgrade logic (database "gmail-cache", stores: "messages", "meta")
- [x] Implement `putMessages(messages: CacheMessage[])` — bulk upsert into "messages" store
- [x] Implement `getMessage(id: string)` and `getMessagesByLabel(labelId: string)` using index
- [x] Implement `getMeta(key: string)` and `setMeta(key: string, value: any)` for metadata store
- [x] Implement `getMessagesWithoutDates(batchSize?: number)` — query messages where `internalDate === null`, return a page at a time for granular background processing
- [x] Implement `clearAll()` for cache reset
- [x] Implement `getMessageCount()` for progress reporting (date coverage tracked via meta store)
- [x] Write tests for all IndexedDB operations (use `fake-indexeddb` or in-memory mock)
- [x] Run tests — must pass before task 2

### Task 2: Gmail batch API support (`gmail-api.ts`)
- [ ] Add `fetchLabelMessageIds(labelName: string, scopeDate?: string)` — paginated `messages.list q=label:X [after:DATE]`, returns all message IDs (no per-message fetch)
- [ ] Add `batchFetchDates(messageIds: string[])` — single Gmail batch API call (`POST /batch/gmail/v1`), up to 100 messages per call, returns `{ id, internalDate }[]`. Caller iterates in pages for granular progress.
- [ ] Add multipart MIME request builder for batch API (Content-Type: multipart/mixed)
- [ ] Add batch response parser (multipart MIME response → individual JSON responses)
- [ ] Update `buildSearchQuery` if needed for label-only queries
- [ ] Write tests for `fetchLabelMessageIds` (mock `messages.list` pagination)
- [ ] Write tests for `batchFetchDates` (mock batch API request/response)
- [ ] Write tests for MIME builder and parser
- [ ] Run tests — must pass before task 3

### Task 3: Cache manager module (`cache-manager.ts`)
- [ ] Create `packages/site-gmail/src/cache-manager.ts` with `CacheManager` class
- [ ] Implement Phase 1: label query loop — fetch all labels, then `fetchLabelMessageIds` for each, cross-reference into `{ id, labelIds }`, store in IndexedDB via `cache-db.ts`
- [ ] Implement Phase 2: batch date fetch — get messages without dates from IndexedDB in pages (e.g., 100 at a time), call `batchFetchDates` per page, update IndexedDB and report progress after each page
- [ ] Implement progress reporting: `{ phase: "labels" | "dates" | "complete", labelsTotal, labelsDone, datesTotal, datesDone }`
- [ ] Implement `queryLabel(labelId, location, scopeTimestamp)` — read from IndexedDB, filter by date and location if available, return count + co-occurring label IDs
- [ ] Implement scope fallback: if dates not cached for queried messages, run `fetchLabelMessageIds(labelName, afterDate)` as substitute, cross-reference returned IDs against IndexedDB to derive co-occurring labels
- [ ] Implement account change detection: compare stored account with current, clear IndexedDB on mismatch
- [ ] Implement incremental refresh: on subsequent runs, only fetch new messages (compare with stored newest date)
- [ ] Write tests for CacheManager (mock cache-db and gmail-api)
- [ ] Run tests — must pass before task 4

### Task 4: Background service worker integration (`background.ts`)
- [ ] Import and instantiate `CacheManager` in background.ts
- [ ] Auto-start cache population on first Gmail tab detection (from existing `resultsReady` flow). Once started, continue fetching even if user navigates away from Gmail (auth token persists). Use `chrome.alarms` to keep SW alive during active fetch.
- [ ] Handle `queryLabel` message — call `cacheManager.queryLabel(labelId, location, scope)`, return result
- [ ] Push `cacheState` updates to connected sidepanel ports during fetch progress
- [ ] Handle account changes (from `resultsReady` accountPath) — reset cache manager
- [ ] Ensure cache manager handles SW shutdown/restart gracefully (IndexedDB persists, re-check state on restart)
- [ ] Write tests for background message handling
- [ ] Run tests — must pass before task 5

### Task 5: Sidepanel refactor (`sidepanel.ts`)
- [ ] Remove all broad build state (`broadFetchId`, `broadQuery`, `broadPaused`, `broadPendingToken`)
- [ ] Remove all targeted fetch state (`targetedFetchId`, `targetedInProgress`, `targetedQuery`, `targetedOldest`)
- [ ] Remove `mergeMessages`, `saveMsgCache`, `loadMsgCache`, `startBroadBuild`, `continueBroadBuild`, `startTargetedFetch`, `clearTargetedState` and all `messagePageReady` handling
- [ ] Replace with: listen for `cacheState` pushed updates from background — update progress display (`formatCacheStatus`, `updateCacheProgress`)
- [ ] On label click: send `queryLabel` to background, display result (count + filtered labels)
- [ ] On scope/location change: re-send `queryLabel` with new parameters
- [ ] Adapt `renderFilteredLabels` to use cache query results instead of local `filterMessages`
- [ ] Keep UI rendering logic (label tree, columns, dimming, progress icons) largely intact
- [ ] Write tests for new sidepanel message handling
- [ ] Run tests — must pass before task 6

### Task 6: Remove old cache module
- [ ] Delete `packages/site-gmail/src/msg-cache.ts`
- [ ] Remove all imports of msg-cache from sidepanel.ts (verify none remain)
- [ ] Remove old localStorage keys (`ca_msg_cache_*`) — add migration: on first run, detect old keys and delete them
- [ ] Update `packages/core/src/types.ts` if MsgCache type is exported (remove or replace)
- [ ] Delete old test files that test msg-cache (`tests/msg-cache.test.ts`, `tests/msg-cache-filtering.test.ts`, `tests/broad-build.test.ts`, `tests/targeted-fetch.test.ts`)
- [ ] Run tests — must pass before task 7

### Task 7: Verify acceptance criteria
- [ ] Verify label selection shows correct message count (matches Gmail UI)
- [ ] Verify scope filtering works (with dates cached and with fallback)
- [ ] Verify progress display shows label fetch phase and date fetch phase
- [ ] Verify cache survives panel close/reopen
- [ ] Verify cache handles account switch correctly
- [ ] Verify incremental refresh works on subsequent opens
- [ ] Run full test suite (unit tests)
- [ ] Run linter — all issues must be fixed

### Task 8: [Final] Update documentation
- [ ] Update CLAUDE.md project structure section (new files, removed files)
- [ ] Update chrome-extension learnings if new patterns discovered
- [ ] Remove debug logging (`console.log("[cache]..."`) added during investigation

## Technical Details

### Gmail Batch API Format
```
POST https://www.googleapis.com/batch/gmail/v1
Content-Type: multipart/mixed; boundary=batch_boundary

--batch_boundary
Content-Type: application/http
Content-ID: <msg1>

GET /gmail/v1/users/me/messages/MSG_ID_1?format=minimal&fields=id,internalDate

--batch_boundary
Content-Type: application/http
Content-ID: <msg2>

GET /gmail/v1/users/me/messages/MSG_ID_2?format=minimal&fields=id,internalDate

--batch_boundary--
```

### Label Query Strategy
- System labels to query: INBOX, SENT, IMPORTANT, STARRED, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_UPDATES, CATEGORY_PROMOTIONS, CATEGORY_FORUMS, UNREAD
- User labels: all from `labels.list` where `type === "user"`
- Cross-reference: message M appearing in queries for labels A, B, C → `labelIds: [A, B, C]`
- Messages not appearing in any label query are captured by a final `has:nouserlabels` query

### Scope Fallback Logic
When user selects a scope (e.g., "1 year") and dates aren't cached:
1. Check IndexedDB for messages with the selected label that have `internalDate !== null`
2. If all have dates → filter locally, return count + co-occurring labels
3. If some missing dates → run `fetchLabelMessageIds(labelName, afterDate)` as substitute
4. Cross-reference returned message IDs against IndexedDB to derive co-occurring labels (the label data is already complete from Phase 1)
5. Continue background date fetching so subsequent scope changes can filter locally

### Incremental Refresh
On subsequent cache manager starts:
1. Read stored "fetchState" from IndexedDB meta
2. If label queries completed previously, check for new labels and re-query only those
3. For existing labels, run `messages.list q=label:X` with `after:` date from last fetch
4. Merge new message IDs into existing records (upsert by ID)
5. Batch-fetch dates for new messages only

## Post-Completion

**Manual verification:**
- Test with Gmail account that has 90K+ messages and ~100 labels
- Verify initial load completes in seconds, not minutes
- Verify labels with "only user labels" messages (the Gmail API quirk) now show correct counts
- Test scope changes with partially-cached dates
- Test service worker restart during fetch
- Test panel close/reopen during fetch
