# Gmail Extension Data Flow

## Components

- **Sidepanel** (`sidepanel.ts`) — UI layer. Expresses user intent via messages. Does not resolve descendants, build URLs, or query the cache directly.
- **Service Worker** (`background.ts`) — Coordinator. Handles cache queries, Gmail navigation, and pushes results to the sidepanel.
- **Cache Manager** (`cache-manager.ts`) — Data layer. Fetches and indexes Gmail messages, resolves label descendants, answers label queries.
- **Gmail API** (`gmail-api.ts`) — Network layer. OAuth2 auth, label fetch, message ID fetch, batch date fetch, search query building.
- **Cache DB** (`cache-db.ts`) — IndexedDB persistence. Stores messages with label cross-references, fetch state metadata, and label indexes.

## Message Types (sidepanel → service worker)

| Message | Purpose |
|---------|---------|
| `initWindow` | Sidepanel opened — sends windowId so service worker can track which Gmail tab belongs to which panel |
| `selectionChanged` | User selected/deselected a label, changed scope, or toggled include-children. Carries `{ labelId, includeChildren, scope, scopeTimestamp, seq }`. Service worker queries cache and navigates Gmail. |
| `filtersOff` | Navigate Gmail to inbox without changing label selection (used when switching to Summary tab with return-to-inbox enabled) |
| `fetchLabels` | Request Gmail label list (used on first load and account switch) |
| `fetchCounts` | Request per-label message counts from cache |
| `syncSettings` | Push display settings (showStarred, showImportant) to service worker |
| `syncState` | Push UI state (returnToInbox, onFiltersTab) to service worker |
| `setPinMode` | Change pin mode (pinned vs autohide-site) |

## Message Types (service worker → sidepanel)

| Message | Purpose |
|---------|---------|
| `resultsReady` | Gmail tab detected — carries `accountPath` so sidepanel can initialize |
| `notOnGmail` | Active tab is not Gmail |
| `labelsReady` | Label list fetched — carries `labels` array |
| `labelsError` | Label fetch failed |
| `labelResult` | Query result for selected label — carries `labelId`, `count`, `coLabelCounts`, `seq` |
| `countsReady` | Per-label message counts — carries `counts` map |
| `cacheState` | Cache build progress — carries `phase`, `labelsTotal`, `labelsDone`, `datesTotal`, `datesDone` |
| `userNavigated` | User navigated Gmail to a different list view (not caused by the extension) |

## Key Flows

### Label Selection

1. User clicks a label in the sidepanel
2. Sidepanel sends `selectionChanged { labelId, includeChildren, scope, scopeTimestamp, seq }`
3. Service worker calls `cacheManager.queryLabel(labelId, includeChildren, scopeTimestamp)`
4. Cache manager resolves descendants internally via prefix matching when `includeChildren` is true
5. Service worker resolves label name(s) from `cacheManager.getLabels()` and builds Gmail URL
6. Service worker navigates Gmail tab and stores the hash in `lastExtensionNavHash`
7. Service worker responds with `labelResult { labelId, count, coLabelCounts, seq }`

### Label Deselection

1. User clicks the active label to deselect
2. Sidepanel sends `selectionChanged { labelId: null, includeChildren, scope, scopeTimestamp, seq }`
3. Service worker navigates Gmail to `#all` (or scoped search if scope is set)
4. Service worker responds with empty `labelResult { labelId: null, count: 0, coLabelCounts: {}, seq }`

### Cache Complete Re-query

1. Cache manager finishes building and fires `cacheState { phase: "complete" }` via progress callback
2. Service worker checks `lastSelection` — if a label is active, re-runs `queryLabel` with stored parameters and pushes updated `labelResult` to all connected sidepanels
3. Service worker unconditionally pushes `countsReady` to all connected sidepanels (regardless of active label)
4. Sidepanel does NOT trigger re-queries on cache complete — it only uses `cacheState` for progress bar display

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
