---
layout: default
title: Gmail — Storage Layout
---

[Home](../..) | [Gmail](.) | [Privacy](privacy) | [Development](../development)

---

[Data Flow](data-flow) | [Storage Layout](storage-layout)

---

# Storage Layout

Where each piece of state lives, who reads/writes it, and how long it lasts. See [data-flow](data-flow) for message protocols.

## chrome.storage.local

Persistent across browser restarts. Cleared on extension uninstall. Global — shared across all windows. Both the service worker and sidepanel can read/write. The service worker listens for changes via `chrome.storage.onChanged`.

### Display settings (read by SW)

These settings are written by the sidepanel and read by the SW via `onSettingChanged`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ca_show_starred` | boolean | `false` | Show Starred in label list |
| `ca_show_important` | boolean | `false` | Show Important in label list |
| `ca_include_children` | boolean | `true` | Include sub-labels when selecting a parent (affects Gmail URL and cache query) |
| `ca_concurrency` | number | `10` | Parallel API calls for cache build |
| `ca_pin_mode` | PinMode | `"pinned"` | Auto-hide: `"pinned"` or `"autohide-site"` |
| `ca_return_to_inbox` | boolean | `true` | Navigate Gmail to inbox when panel closes from Search tab |

### Display settings (sidepanel only)

Written and read by the sidepanel. The SW does not use these.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ca_label_columns` | number | `3` | Number of label columns |
| `ca_show_counts` | boolean | `true` | Show email counts next to labels |
| `ca_zoom_levels` | `Record<string, number>` | `{}` | Per-context zoom levels (e.g. `{ gmail: 1.2, help: 1.0 }`) |

### Per-window state (last-writer-wins)

Written by the sidepanel on user action. Global storage, so two windows overwrite each other — the last-used value persists for next open. Acceptable tradeoff for "remember where I was."

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ca_active_label` | string \| null | `null` | Selected label ID |
| `ca_active_label_name` | string \| null | `null` | Selected label display name |
| `ca_scope_value` | string | `"any"` | Scope dropdown value (e.g. `"1m"`, `"1y"`, `"any"`) |

## chrome.storage.session

Survives SW idle shutdown (~30s), cleared on browser close. Global. Used only for state the SW needs to restore after suspension.

| Key | Type | Description |
|-----|------|-------------|
| `accountPath` | string | Gmail account path (e.g. `/mail/u/0/`). Read by the alarm handler to restart the orchestrator after SW suspension. |

## IndexedDB (meta store)

Persistent across browser restarts. Shared between SW and extension pages (same origin). Managed by the cache manager via `cache-db.ts`.

| Key | Type | Description |
|-----|------|-------------|
| `account` | string | Gmail account path. Used to detect account switches — if it differs from the current path, the cache is cleared. |
| `fetchState` | `{ phase: "complete", lastFetchTimestamp: number }` | Cache build state. `lastFetchTimestamp` is used to determine incremental refresh scope. |
| `cacheDepth` | `{ timestamp: number \| null }` | How far back label indexes cover. `null` = full coverage (all time). |
| `labelIdx:{labelId}` | `string[]` | Message IDs belonging to a label. One entry per label. Co-labels computed by intersecting these arrays. |

## In-memory: Service Worker

Lost on SW idle shutdown (~30s). Rebuilt from IndexedDB and `chrome.storage` on restart.

### Port state (`Map<Port, PortState>`)

One entry per connected sidepanel (one per window). Tracks per-window state for navigation and result routing.

| Field | Type | Description |
|-------|------|-------------|
| `onSearchTab` | boolean | Whether the Search tab is active. Inferred from `selectionChanged` (true) and `filtersOff` (false). Used by disconnect handler to decide return-to-inbox. |
| `windowId` | number \| null | Chrome window ID. Set by `initWindow`. |
| `gmailTabId` | number \| null | Active Gmail tab in this window. |
| `gmailTabUrl` | string \| null | URL of the active Gmail tab. |
| `lastScopeTimestamp` | number \| null | Last scope from this port's `selectionChanged`. |
| `lastSelection` | PortSelection \| null | Last full selection (`{ labelId, scopeTimestamp }`). |
| `pushGeneration` | number | Monotonic counter to discard stale async pushes for this port. |

### Module-level state

| Variable | Type | Description |
|----------|------|-------------|
| `pinMode` | PinMode | Current pin mode — loaded from `chrome.storage.local` on start. |
| `returnToInbox` | boolean | Return-to-inbox setting — loaded from `chrome.storage.local` on start. |
| `includeChildren` | boolean | Include sub-labels — loaded from `chrome.storage.local` on start. |
| `currentAccountPath` | string \| null | Active Gmail account. Persisted to `chrome.storage.session`. |
| `labelsPushed` | boolean | Whether `labelsReady` has been pushed to ports in this session. Reset on cache reset. |

### Cache Manager state

Rebuilt from IndexedDB on `start()`. The cache manager is a singleton owned by the SW.

| Field | Type | Description |
|-------|------|-------------|
| `labels` | GmailLabel[] | In-memory label list. Loaded from Gmail API on `start()`. |
| `processedLabels` | Set\<string\> | Labels already indexed. Rebuilt from IndexedDB on warm start. |
| `scopedIdSets` | Map\<number, Set\<string\>\> | Per-timestamp scoped message ID sets. Preserved across cache reset (timestamps are immutable). |
| `filterConfig` | FilterConfig | Current filter from the SW. Updated on `setFilterConfig()`. |
| `initialBuildComplete` | boolean | Whether the initial cache build finished. Gates `pushResults`. |
| `cacheDepthTimestamp` | number \| null | Mirror of IndexedDB `cacheDepth`. |
| `lastRefreshTimestamp` | number \| null | Mirror of IndexedDB `fetchState.lastFetchTimestamp`. |
| `continuations` | Map\<string, Continuation\> | In-flight pagination tokens per action. |
| `orchestratorConcurrency` | number | Parallel API call limit. Updated from `chrome.storage.local`. |

## In-memory: Sidepanel (per window)

Each Chrome window has its own sidepanel page instance. Lost when the panel closes. Loaded from `chrome.storage.local` on panel open via async `init()`.

### Search tab state

| Variable | Type | Description |
|----------|------|-------------|
| `activeLabelId` | string \| null | Currently selected label. Loaded from storage, saved on change. |
| `scopeValue` | string | Current scope dropdown value. Loaded from storage, saved on change. |
| `cachedLabels` | GmailLabel[] \| null | Label list from last `labelsReady` push. |
| `labelCounts` | Record\<string, counts\> \| null | Label counts from last `filterResults` push. |
| `lastLabelResult` | object \| null | Co-label query result from last `filterResults` push. |
| `lastResultsPartial` | boolean | Whether the last push was partial (build in progress). |

### Shell state

| Variable | Type | Description |
|----------|------|-------------|
| `currentTab` | `"summary" \| "search"` | Active tab. Per-window, not persisted. |
| `currentPinMode` | PinMode | Pin mode. Loaded from storage on init. |
| `returnToInbox` | boolean | Return-to-inbox setting. Loaded from storage on init. |
| `zoomLevels` | Record\<string, number\> | Per-context zoom. Loaded from storage, saved on change. |
| `onGmailPage` | boolean | Whether the active tab is Gmail. Set by `resultsReady`/`notOnGmail`. |
