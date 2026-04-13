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
| `initWindow` | Sidepanel opened — sends windowId so service worker can track which Gmail tab belongs to which panel. Always followed immediately by `selectionChanged`. |
| `selectionChanged` | User selected/deselected a label or changed scope. Carries `{ labelId, scopeTimestamp }`. Service worker converts timestamp to date string for Gmail URLs, navigates Gmail, and calls `cacheManager.setFilterConfig()`. Also signals the search tab is active. `includeChildren` is read from `chrome.storage.local` by the SW. |
| `filtersOff` | Navigate Gmail to inbox without changing label selection (used when switching away from Search tab with return-to-inbox enabled). Also signals the search tab is inactive. |
| `resetCache` | Clear IndexedDB cache and restart the orchestrator from scratch |

## Message Types (service worker → sidepanel)

| Message | Purpose |
|---------|---------|
| `resultsReady` | Gmail tab detected — carries `accountPath` so sidepanel can initialize |
| `notOnGmail` | Active tab is not Gmail |
| `labelsReady` | Label list pushed proactively — carries `labels` array (includes synthetic NONE label). Sent on warm reconnect (from cache manager's in-memory list) and on cold start (when initial build begins). |
| `filterResults` | Pushed results from cache manager — carries `labelId`, `count`, `coLabelCounts`, `counts`, `filterConfig`, `partial` |
| `cacheState` | Cache build progress — carries `phase`, `labelsTotal`, `labelsDone`, optional `currentLabel`. Phases: `labels` (initial build — fetching all-time message IDs per label), `scope` (fetching scoped message ID set via paginated search), `complete` (all work done, cache idle) |
| `userNavigated` | User navigated Gmail to a different list view (not caused by the extension) |

## Key Flows

### Filter Change

When the user changes filter criteria (clicks a label, deselects one, or changes scope), the sidepanel expresses the new state via `selectionChanged` and the service worker + cache manager handle the rest. Display settings (include-children, show starred, etc.) follow a separate flow via `chrome.storage.local` — see [Display Settings Change](#display-settings-change).

1. User changes filter criteria in the sidepanel (clicks label or changes scope)
2. Sidepanel sends `selectionChanged { labelId, scopeTimestamp }` to service worker
3. Service worker navigates Gmail immediately (resolves label names, builds URL, updates tab)
4. Service worker calls `cacheManager.setFilterConfig({ labelId, includeChildren, scopeTimestamp })` (includeChildren from shared settings)
5. Cache manager pushes results to service worker via registered callback whenever data is available:
   - Immediately if data is cached and initial build is complete
   - After orchestrator fetches missing label/scope data
   - Progressively during initial build (after each label is indexed)
   - Suppressed during cache reset (old view stays frozen until rebuild completes)
   - When cache refresh finishes
6. Service worker relays each push as `filterResults` to sidepanel
7. Sidepanel renders whatever arrives — progressively accurate counts

No request/response. No seq correlation. Staleness handled by filter config comparison in push callback.

### Cache Orchestrator

The cache manager uses a single orchestrator loop with configurable concurrency (default 10). Multiple labels are fetched in parallel via `Promise.all`. The loop calls `decide()` to determine up to N non-conflicting actions, executes them concurrently, then loops back.

The orchestrator is driven by `cacheManager.setFilterConfig()` signals from the service worker. When the user changes label selection or scope (via `selectionChanged`) or toggles include-children (via `chrome.storage.onChanged`), the service worker calls `cacheManager.setFilterConfig()` which wakes the orchestrator loop. The `decide()` function examines the filter config and cache state to determine the next actions.

#### Priority Order (decide)

1. `fetch-scope` — user has a scope but scoped ID set not yet fetched. Large scope date ranges are split into parallel segments for faster completion.
2. `fetch-label` — user selected a label not yet in cache
3. `fetch-label` (initial build) — labels not yet fully indexed. Always fetches all time (no date restriction). Message IDs accumulated in memory per label, written to IndexedDB once on completion. Includes the synthetic NONE label (`has:nouserlabels`). Results pushed progressively (suppressed during reset).
4. `refresh-label` — cache stale (>10 min), fetch new messages per-label since lastFetchTimestamp. Updates cached scoped ID sets with new message IDs instead of clearing them.
5. Idle — everything cached and fresh, sleep until signaled

Each iteration: `decide()` → execute actions (up to concurrency limit) → loop back. Priority changes take effect on the next iteration.

#### Co-Label Computation

Co-labels are computed by intersecting label indexes rather than reading individual messages. For a selected label, `queryLabel` builds the set of matching message IDs, then for each other label counts `|selectedIdx ∩ otherIdx|`. No per-message IndexedDB store is needed.

### Panel Open / Reconnect

When the side panel opens (or reconnects after a service worker restart), the sidepanel establishes a port connection and the service worker initializes the cache orchestrator.

1. Sidepanel connects to the service worker, sends `initWindow { windowId }` and `selectionChanged { labelId, scopeTimestamp }` with saved values from settings
2. Service worker finds the active Gmail tab, navigates Gmail, calls `cacheManager.setFilterConfig()`, sends `resultsReady { accountPath }` to sidepanel
3. Service worker calls `cacheManager.start(accountPath)` (idempotent — no-op if already running for same account)
4. Cache manager fetches labels from Gmail API and emits a progress callback (on warm reconnect, labels are already in memory)
5. Service worker reads `cacheManager.getLabels()` and sends `labelsReady` to sidepanel
6. Sidepanel stores labels but skips rendering if a label is selected (avoids flash of all labels before co-label filtering)
7. Cache manager pushes `filterResults` to service worker via callback → service worker relays to sidepanel → sidepanel renders the filtered view

**Warm reconnect** (orchestrator already running for this account): the service worker sends both `labelsReady` and `filterResults` to the sidepanel immediately from cached data — no API calls or build needed.

Labels are never requested by the sidepanel — the service worker pushes them proactively. No `fetchLabels` request/response.

See [startup-reconnect.mmd](startup-reconnect.mmd) for the full sequence diagram. See [storage-layout](storage-layout) for the complete list of storage keys and in-memory state.

### Display Settings Change

Shared display settings are stored in `chrome.storage.local` — no port messages needed. The service worker loads them on startup and reacts to changes via `chrome.storage.onChanged`.

1. User toggles a setting in the sidepanel display menu
2. Sidepanel writes to `chrome.storage.local`
3. Service worker's `onSettingChanged` listener fires and applies the change:
   - **showStarred / showImportant** — updates cache manager system label settings, wakes orchestrator to fetch newly enabled labels
   - **includeChildren** — updates `cacheManager.setFilterConfig()` with the new value, re-navigates all Gmail tabs with active labels
   - **concurrency** — updates cache manager parallel fetch limit
   - **pinMode** — updates auto-hide behavior
   - **returnToInbox** — updates disconnect behavior

The service worker infers per-window tab state from `selectionChanged` (search tab active) and `filtersOff` (left search tab).

### Zero-Count Label Hiding

1. `getLabelCounts` omits labels where both own and inclusive counts are zero when scope is active
2. Sidepanel receives `filterResults` with `counts` map and `partial` flag
3. In `renderFilteredLabels`, when no label is selected, scope is not "any", and `partial` is false: hides labels absent from `counts` (zero-count, omitted by cache manager)
4. `addParentChain` preserves tree structure — a parent with own=0 stays visible if a child has count>0
5. When scope is "any", no filtering — all labels shown regardless of count
6. When `partial` is true, no filtering — all labels shown (data is incomplete)

### Synthetic NONE Label

The cache manager includes a synthetic label with ID `NONE` that represents messages with no user-created labels. It is fetched using the Gmail search query `has:nouserlabels` and indexed like any other label. It appears in the sidepanel as "No user labels" among the system labels.

### Search Tab Close (Return to Inbox)

1. User switches to Summary tab with return-to-inbox enabled
2. Sidepanel sends `filtersOff` to service worker
3. Service worker navigates Gmail to `#inbox`
4. No cache query or response — label selection state is preserved

### User Navigation Detection

1. Gmail tab URL changes (hash change)
2. Service worker compares new hash against `lastExtensionNavHash`
3. If hash does NOT match the extension's last navigation and is a list view, service worker sends `userNavigated` to sidepanel
4. Sidepanel clears active label selection
