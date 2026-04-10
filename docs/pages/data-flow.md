# Gmail Extension Data Flow

## Components

- **Sidepanel** (`sidepanel.ts`) — UI layer. Expresses user intent via messages. Does not resolve descendants, build URLs, or query the cache directly.
- **Service Worker** (`background.ts`) — Coordinator. Handles Gmail navigation and relays pushed results to the sidepanel.
- **Cache Manager** (`cache-manager.ts`) — Data layer. Fetches and indexes Gmail messages, resolves label descendants, pushes results via callback when data is available.
- **Gmail API** (`gmail-api.ts`) — Network layer. OAuth2 auth, label fetch, per-page message ID fetch with configurable concurrency, scope-based message search with parallel segments, search query building.
- **Cache DB** (`cache-db.ts`) — IndexedDB persistence. Meta store for label indexes (`labelIdx:*`) and fetch state. No per-message store — co-labels computed via index intersection.

## Message Types (sidepanel → service worker)

| Message | Purpose |
|---------|---------|
| `initWindow` | Sidepanel opened — sends windowId so service worker can track which Gmail tab belongs to which panel |
| `selectionChanged` | User selected/deselected a label, changed scope, or toggled include-children. Carries `{ labelId, includeChildren, scope, scopeTimestamp }`. Service worker navigates Gmail and calls `setFilterConfig`. |
| `filtersOff` | Navigate Gmail to inbox without changing label selection (used when switching to Summary tab with return-to-inbox enabled) |
| `fetchLabels` | Request Gmail label list (used on first load and account switch) |
| `syncSettings` | Push display settings (showStarred, showImportant, concurrency) to service worker |
| `syncState` | Push UI state (returnToInbox, onFiltersTab) to service worker |
| `setPinMode` | Change pin mode (pinned vs autohide-site) |

## Message Types (service worker → sidepanel)

| Message | Purpose |
|---------|---------|
| `resultsReady` | Gmail tab detected — carries `accountPath` so sidepanel can initialize |
| `notOnGmail` | Active tab is not Gmail |
| `labelsReady` | Label list fetched — carries `labels` array (includes synthetic NONE label) |
| `labelsError` | Label fetch failed |
| `filterResults` | Pushed results from cache manager — carries `labelId`, `count`, `coLabelCounts`, `counts`, `filterConfig`, `partial` |
| `cacheState` | Cache build progress — carries `phase`, `labelsTotal`, `labelsDone`, optional `currentLabel`. Phases: `labels` (initial build — fetching all-time message IDs per label), `scope` (fetching scoped message ID set via paginated search), `scope-done` (scope fetch complete), `complete` (all work done, cache idle) |
| `userNavigated` | User navigated Gmail to a different list view (not caused by the extension) |

## Key Flows

### Filter Change

All user-initiated filter changes follow the same flow. The user may click a label, deselect one, change scope, or toggle include-children — the sidepanel expresses the new filter state and the service worker + cache manager handle the rest.

1. User changes filter criteria in the sidepanel (clicks label, changes scope, toggles include-children)
2. Sidepanel sends `selectionChanged { labelId, includeChildren, scope }`
3. Service worker navigates Gmail immediately (resolves label names, builds URL, updates tab)
4. Service worker calls `cacheManager.setFilterConfig({ labelId, includeChildren, scope })`
5. Cache manager pushes results via registered callback whenever data is available:
   - Immediately if data is cached (label indexes exist for the requested scope)
   - During initial build, `setFilterConfig` pushes empty counts with `partial: true`; the orchestrator then pushes progressively after each label is indexed
   - After orchestrator fetches missing label/scope data
   - Again when cache completes or refresh finishes
6. Service worker relays each push as `filterResults` to sidepanel
7. Sidepanel renders whatever arrives — progressively accurate counts

No request/response. No seq correlation. Staleness handled by filter config comparison in push callback.

### Cache Orchestrator

The cache manager uses a single orchestrator loop with configurable concurrency (default 10). Multiple labels are fetched in parallel via `Promise.all`. The loop calls `decide()` to determine up to N non-conflicting actions, executes them concurrently, then loops back.

The orchestrator is driven by `setFilterConfig()` signals from the service worker. When the user changes label selection, scope, or include-children, the service worker calls `setFilterConfig()` which wakes the orchestrator loop. The `decide()` function examines the filter config and cache state to determine the next actions.

#### Priority Order (decide)

1. `fetch-scope` — user has a scope but scoped ID set not yet fetched. Large scope date ranges are split into parallel segments for faster completion.
2. `fetch-label` — user selected a label not yet in cache
3. `fetch-label` (initial build) — labels not yet fully indexed. Always fetches all time (no date restriction). Message IDs accumulated in memory per label, written to IndexedDB once on completion. Includes the synthetic NONE label (`has:nouserlabels`).
4. `fetch-scope` (background expansion) — pre-fetch wider scoped ID sets through expansion tiers (1w → 2w → 1m → 2m → 6m → 1y → 3y → 5y). Only runs when a scope is active and initial build is complete.
5. `refresh-label` — cache stale (>10 min), fetch new messages per-label since lastFetchTimestamp. Updates cached scoped ID sets with new message IDs instead of clearing them.
6. Idle — everything cached and fresh, sleep until signaled

Each iteration: `decide()` → execute actions (up to concurrency limit) → loop back. Priority changes take effect on the next iteration.

#### Co-Label Computation

Co-labels are computed by intersecting label indexes rather than reading individual messages. For a selected label, `queryLabel` builds the set of matching message IDs, then for each other label counts `|selectedIdx ∩ otherIdx|`. No per-message IndexedDB store is needed.

### Zero-Count Label Hiding

1. `getLabelCounts` omits labels where both own and inclusive counts are zero when scope is active
2. Sidepanel receives `filterResults` with `counts` map and `partial` flag
3. In `renderFilteredLabels`, when no label is selected, scope is not "any", and `partial` is false: hides labels absent from `counts` (zero-count, omitted by cache manager)
4. `addParentChain` preserves tree structure — a parent with own=0 stays visible if a child has count>0
5. When scope is "any", no filtering — all labels shown regardless of count
6. When `partial` is true, no filtering — all labels shown (data is incomplete)

### Synthetic NONE Label

The cache manager includes a synthetic label with ID `NONE` that represents messages with no user-created labels. It is fetched using the Gmail search query `has:nouserlabels` and indexed like any other label. It appears in the sidepanel as "No user labels" among the system labels.

### Filters Off (Summary Tab)

1. User switches to Summary tab with return-to-inbox enabled
2. Sidepanel sends `filtersOff`
3. Service worker navigates Gmail to `#inbox`
4. No cache query or response — label selection state is preserved

### User Navigation Detection

1. Gmail tab URL changes (hash change)
2. Service worker compares new hash against `lastExtensionNavHash`
3. If hash does NOT match the extension's last navigation and is a list view, broadcasts `userNavigated`
4. Sidepanel clears active label selection on `userNavigated`
