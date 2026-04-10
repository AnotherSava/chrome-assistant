# Gmail Extension Data Flow

## Components

- **Sidepanel** (`sidepanel.ts`) — UI layer. Expresses user intent via messages. Does not resolve descendants, build URLs, or query the cache directly.
- **Service Worker** (`background.ts`) — Coordinator. Handles Gmail navigation and relays pushed results to the sidepanel.
- **Cache Manager** (`cache-manager.ts`) — Data layer. Fetches and indexes Gmail messages, resolves label descendants, pushes results via callback when data is available.
- **Gmail API** (`gmail-api.ts`) — Network layer. OAuth2 auth, label fetch, message ID fetch, scope-based message search, search query building.
- **Cache DB** (`cache-db.ts`) — IndexedDB persistence. Stores messages with label cross-references, fetch state metadata, and label indexes.

## Message Types (sidepanel → service worker)

| Message | Purpose |
|---------|---------|
| `initWindow` | Sidepanel opened — sends windowId so service worker can track which Gmail tab belongs to which panel |
| `selectionChanged` | User selected/deselected a label, changed scope, or toggled include-children. Carries `{ labelId, includeChildren, scope, scopeTimestamp }`. Service worker navigates Gmail and calls `setFilterConfig`. |
| `filtersOff` | Navigate Gmail to inbox without changing label selection (used when switching to Summary tab with return-to-inbox enabled) |
| `fetchLabels` | Request Gmail label list (used on first load and account switch) |
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
| `filterResults` | Pushed results from cache manager — carries `labelId`, `count`, `coLabelCounts`, `counts`, `filterConfig` |
| `cacheState` | Cache build progress — carries `phase`, `labelsTotal`, `labelsDone`, optional `currentLabel`. Phases: `labels` (initial build — fetching message IDs per label, building `labelIdx:*` indexes), `scope` (fetching scoped message ID set via paginated `messages.list after:DATE`), `scope-done` (scope fetch complete), `expanding` (gap-fill for widened scope or background depth expansion through tiers), `complete` (all work done, cache idle) |
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
   - During initial build, `setFilterConfig` pushes labels with empty counts (clears stale data); the orchestrator then pushes progressively after each label is indexed
   - After orchestrator fetches missing label/scope data
   - Again when cache completes, gap-fill finishes, or expansion adds data
6. Service worker relays each push as `filterResults` to sidepanel
7. Sidepanel renders whatever arrives — progressively accurate counts

No request/response. No seq correlation. Staleness handled by filter config comparison in push callback.

### Cache Orchestrator

The cache manager uses a single orchestrator loop that fetches one page at a time, stores results, then calls `decide()` to determine what to do next. No concurrent API calls (default concurrency=1), no generation counters, no race conditions.

The orchestrator is driven by `setFilterConfig()` signals from the service worker. When the user changes label selection, scope, or include-children, the service worker calls `setFilterConfig()` which wakes the orchestrator loop. The `decide()` function examines the filter config and cache state to determine the next action.

#### Priority Order (decide)

1. `fetch-scope` — user has a scope but scoped ID set not yet fetched
2. `fetch-label` — user selected a label not yet in cache
3. `fetch-label` (initial build) — labels not yet fully indexed, page at a time
4. `gap-fill-label` — user widened scope beyond cache depth, fetch missing segment per-label
5. `expand-label` — background depth expansion through tiers (1w → 2w → 1m → 2m → 6m → 1y → 3y → 5y → all)
6. `refresh-label` — cache stale (>10 min), fetch new messages per-label since lastFetchTimestamp
7. Idle — everything cached and fresh, sleep until signaled

Each iteration: `decide()` → execute action (one API page) → store results → loop back. Priority changes take effect on the next iteration — the current page finishes, then `decide()` naturally picks the new priority.

#### Progressive Cache Deepening

The cache tracks how far back it has fetched via `cacheDepth` metadata in IndexedDB (`{ timestamp: number | null }`, where `null` means full coverage). This enables fast initial loads and incremental expansion.

- Scoped initial build: `start(accountPath)` with a scope fetches per-label with `after:DATE`, stores `cacheDepth: { timestamp: scopeTimestamp }`
- Narrowing scope: new scope is within `cacheDepth` — orchestrator fetches scoped IDs (one paginated fetch) and intersects locally. Scoped ID sets are cached per-timestamp for instant switching.
- Widening scope: `decide()` returns `gap-fill-label` actions to fetch the missing segment per-label using `after:` and `before:`. `cacheDepth` updated when all labels complete.
- "Any" scope from partial cache: gap-fill fetches from `cacheDepth` backward using `before:cacheDepthDate`. On completion, `cacheDepth` set to `null`.
- Background expansion: after initial build, `decide()` returns `expand-label` actions through predefined tiers. Each tier gap-fills all labels, then advances `cacheDepth`. Interruptible — higher-priority actions take precedence.
- Incremental refresh: `decide()` returns `refresh-label` actions fetching per-label with `after:lastFetchTimestamp`. Does not regress `cacheDepth`.

### Zero-Count Label Hiding

1. `getLabelCounts` includes all indexed labels — zero-count entries have `{ own: 0, inclusive: 0 }`, labels not yet indexed are absent from the map
2. Sidepanel receives `filterResults` with the full `counts` map
3. In `renderFilteredLabels`, when no label is selected, scope is not "any", and cache build is complete: hides labels with explicit zero counts (own=0 AND inclusive=0). Labels absent from `counts` (not yet indexed) remain visible.
4. A parent with own=0 but inclusive>0 stays visible (descendants have messages)
5. When scope is "any", no filtering — all labels shown regardless of count
6. During initial build (phase is not "complete" or "expanding"), no filtering — all labels shown

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
