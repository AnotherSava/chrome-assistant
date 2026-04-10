import type { PinMode } from "@core/types.js";
import { fetchLabels, type GmailLabel, buildSearchQuery } from "./gmail-api.js";
import { CacheManager, type CacheProgress, type ResultPush } from "./cache-manager.js";

const GMAIL_PATTERN = /^https:\/\/mail\.google\.com\//;

interface PortSelection { labelId: string | null; includeChildren: boolean; scopeTimestamp: number | null }
interface PortState { returnToInbox: boolean; onFiltersTab: boolean; gmailTabId: number | null; gmailTabUrl: string | null; windowId: number | null; lastScopeTimestamp: number | null | undefined; lastSelection: PortSelection | null; pushGeneration: number }
const portState = new Map<chrome.runtime.Port, PortState>();
const pendingReturnToInbox = new Map<number, ReturnType<typeof setTimeout>>();
/** Last hash fragment the extension navigated each tab to via selectionChanged — used to suppress userNavigated for our own navigations. */
const lastExtensionNavHash = new Map<number, string>();
/** Per-tab generation counter for navigateGmailToLabel — prevents stale loadLabels callbacks from navigating to an outdated label after rapid label changes. Keyed by tabId to avoid cross-tab interference in multi-window scenarios. */
const navGeneration = new Map<number, number>();
let pinMode: PinMode = "pinned";

const cacheManager = new CacheManager();
let currentAccountPath: string | null = null;
const CACHE_ALARM_NAME = "cache-keepalive";

/** Relay cache manager result pushes to all connected sidepanel ports. For ports whose last selection differs from the pushed filterConfig, compute and send their own results so multi-window use stays fresh. */
function relayResultPush(result: ResultPush): void {
  const { labelId, count, coLabelCounts, counts, filterConfig, partial } = result;
  // Ensure all active port scopes are fetched by the orchestrator (multi-window support)
  for (const [, s] of portState) {
    const ts = s.lastSelection?.scopeTimestamp ?? s.lastScopeTimestamp;
    if (ts !== null && ts !== undefined) cacheManager.requestScopeFetch(ts);
  }
  for (const [port, state] of portState) {
    const sel = state.lastSelection;
    // Determine the port's effective scope — from explicit selection or from stored scope
    const portScope = sel?.scopeTimestamp ?? state.lastScopeTimestamp;
    const effectivePortScope = portScope ?? null;
    // If this port's selection matches the pushed filterConfig, relay directly
    if (sel ? (sel.labelId === filterConfig.labelId && sel.includeChildren === filterConfig.includeChildren && sel.scopeTimestamp === filterConfig.scopeTimestamp) : (effectivePortScope === filterConfig.scopeTimestamp)) {
      // Bump generation to invalidate any in-flight pushResultsForPort() for this port
      state.pushGeneration++;
      try {
        port.postMessage({ type: "filterResults", labelId, count, coLabelCounts, counts, filterConfig, partial });
      } catch { /* port may be dead */ }
    } else {
      // This port has a different selection or scope — compute its own results
      pushResultsForPort(port, sel ?? { labelId: null, includeChildren: false, scopeTimestamp: effectivePortScope });
    }
  }
}

/** Compute and send results for a specific port's selection. Skips when the port's scope hasn't been fetched yet — the orchestrator will push results once the scope arrives via requestScopeFetch. */
function pushResultsForPort(port: chrome.runtime.Port, sel: PortSelection): void {
  const { labelId, includeChildren, scopeTimestamp } = sel;
  // Guard: don't send unscoped data tagged as scoped — wait for scope fetch to complete
  if (!cacheManager.isScopeReady(scopeTimestamp)) return;
  const state = portState.get(port);
  if (!state) return;
  const myGeneration = ++state.pushGeneration;
  const portFilterConfig = { labelId, includeChildren, scopeTimestamp };
  (async () => {
    let portCount = 0;
    let portCoLabelCounts: Record<string, number> = {};
    if (labelId !== null) {
      const result = await cacheManager.queryLabel(labelId, includeChildren, scopeTimestamp);
      // Discard if a newer push started for this port
      if (state.pushGeneration !== myGeneration) return;
      portCount = result.count;
      portCoLabelCounts = result.coLabelCounts;
    }
    const portCounts = await cacheManager.getLabelCounts(undefined, scopeTimestamp);
    // Discard if a newer push started for this port
    if (state.pushGeneration !== myGeneration) return;
    try {
      port.postMessage({ type: "filterResults", labelId, count: portCount, coLabelCounts: portCoLabelCounts, counts: portCounts, filterConfig: portFilterConfig, partial: cacheManager.getCacheDepthTimestamp() === undefined });
    } catch { /* port may be dead */ }
  })().catch(() => { /* swallow errors */ });
}

cacheManager.setResultCallback(relayResultPush);

cacheManager.setProgressCallback((progress: CacheProgress) => {
  for (const [port] of portState) {
    try { port.postMessage({ type: "cacheState", ...progress }); } catch { /* port may be dead */ }
  }
  if (progress.phase === "complete") {
    // Schedule a future wake-up for incremental refresh — only if no alarm is already pending
    chrome.alarms.get(CACHE_ALARM_NAME).then(existing => {
      if (!existing) chrome.alarms.create(CACHE_ALARM_NAME, { delayInMinutes: 11 });
    }).catch(() => {});
  } else if (progress.phase === "expanding") {
    // Keep service worker alive during background expansion
    chrome.alarms.create(CACHE_ALARM_NAME, { periodInMinutes: 0.4 });
  }
});

// Keep service worker alive during active cache fetch; restart orchestrator after SW suspension
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CACHE_ALARM_NAME) {
    if (cacheManager.isOrchestratorRunning()) {
      // Orchestrator is active — just wake it (keeps SW alive during expansion/refresh)
      cacheManager.wakeOrchestrator();
    } else {
      // Service worker was suspended and restarted — restore account and restart orchestrator
      chrome.storage.session.get(["accountPath", "showStarred", "showImportant"], (result) => {
        if (result.accountPath) {
          // Restore system label settings before starting so buildLabelQueryList() includes them
          if (result.showStarred || result.showImportant) {
            cacheManager.showStarred = !!result.showStarred;
            cacheManager.showImportant = !!result.showImportant;
          }
          startOrchestrator(result.accountPath, getScopeForWindow());
        }
      });
    }
  }
});

// Restore pinMode from session storage (survives service worker restarts)
chrome.storage.session.get("pinMode", (result) => {
  if (result.pinMode === "pinned" || result.pinMode === "autohide-site") {
    pinMode = result.pinMode;
  }
});

// We handle open/close manually via togglePanel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

// Show keyboard shortcut in the extension icon tooltip
chrome.commands.getAll((commands) => {
  const cmd = commands.find((c) => c.name === "toggle-sidepanel");
  if (cmd?.shortcut) {
    chrome.action.setTitle({ title: `Gmail Assistant (${cmd.shortcut})` });
  }
});

/** Get the active scope timestamp from the sidepanel port for a specific window. Falls back to any connected port if no window match. */
function getScopeForWindow(windowId?: number): number | null | undefined {
  if (windowId !== undefined) {
    for (const [, state] of portState) {
      if (state.windowId === windowId && state.lastScopeTimestamp !== undefined) return state.lastScopeTimestamp;
    }
  }
  for (const [, state] of portState) {
    if (state.lastScopeTimestamp !== undefined) return state.lastScopeTimestamp;
  }
  return undefined;
}

/** Start the orchestrator for a Gmail account. Idempotent — if already running for the same account, does nothing. On account change, stops and restarts. */
export function startOrchestrator(accountPath: string, scopeTimestamp?: number | null): void {
  if (cacheManager.isOrchestratorRunning() && currentAccountPath === accountPath) return;
  // Invalidate any in-flight pushResultsForPort() calls for all ports so stale data
  // from the previous account doesn't leak through after the switch.
  for (const [, state] of portState) state.pushGeneration++;
  currentAccountPath = accountPath;
  // Persist account path so the alarm handler can restart after SW suspension
  chrome.storage.session.set({ accountPath });
  // Set initial filter config from scope before starting so decide() knows about it.
  // Skip the push to avoid emitting stale counts from the previous account — start() will
  // clear old data and push fresh results after labels load.
  if (scopeTimestamp !== undefined) {
    cacheManager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: scopeTimestamp ?? null }, true);
  }
  chrome.alarms.create(CACHE_ALARM_NAME, { periodInMinutes: 0.4 });
  cacheManager.start(accountPath).catch((err) => {
    console.warn("Orchestrator start failed:", err);
    currentAccountPath = null;
    chrome.alarms.clear(CACHE_ALARM_NAME).catch(() => {});
  });
}

function isGmail(url: string | undefined): boolean {
  return url !== undefined && GMAIL_PATTERN.test(url);
}

function urlHash(url: string): string {
  const idx = url.indexOf("#");
  if (idx === -1) return "";
  try { return decodeURIComponent(url.slice(idx + 1).replace(/\+/g, " ")); } catch { return url.slice(idx + 1).replace(/\+/g, " "); }
}

/** Returns true if the Gmail URL hash is a list/section view (not an individual email). */
export function isGmailListView(url: string): boolean {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return true;
  const hash = url.slice(hashIdx + 1);
  // Known section-only views (no sub-path)
  if (/^(inbox|sent|starred|snoozed|drafts|imp|chats|trash|spam|all|scheduled|settings)$/.test(hash)) return true;
  // Category views: category/social, category/updates, etc.
  if (/^category\/\w+$/.test(hash)) return true;
  // Label views: label/Name or label/Name/SubName (but not label/Name/MessageId)
  // Gmail message IDs in URLs are 16+ char alphanumeric strings
  if (hash.startsWith("label/")) {
    const lastSegment = hash.split("/").pop() ?? "";
    return lastSegment.length < 16 || !/^[A-Za-z0-9_-]+$/.test(lastSegment);
  }
  // Search views — but not individual emails opened from search (search/.../MessageId)
  if (hash.startsWith("search/")) {
    const lastSegment = hash.split("/").pop() ?? "";
    return lastSegment.length < 16 || !/^[A-Za-z0-9_-]+$/.test(lastSegment);
  }
  // Settings sub-pages
  if (hash.startsWith("settings/")) return true;
  // Anything else with a long last segment is likely a message view
  const segments = hash.split("/");
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    if (last.length >= 16 && /^[A-Za-z0-9_-]+$/.test(last)) return false;
  }
  return true;
}

function gmailAccountPath(url: string | undefined): string {
  const match = url?.match(/\/mail\/u\/(\d+)\//);
  return `/mail/u/${match ? match[1] : "0"}/`;
}

async function closePanel(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.sidePanel.close({ windowId: tab.windowId });
  } catch (err) {
    console.warn("Could not close side panel:", err);
  }
}

/** Navigate a Gmail tab to show the given label. Uses cached labels for URL building; falls back to loadLabels if empty. A generation guard prevents stale loadLabels callbacks from overriding a newer navigation after rapid label changes. */
function navigateGmailToLabel(tabId: number, base: string, labelId: string, includeChildren: boolean, scope: string | null): void {
  const gen = (navGeneration.get(tabId) ?? 0) + 1;
  navGeneration.set(tabId, gen);
  const labels = cacheManager.getLabels();
  const doNav = (labels: GmailLabel[]): void => {
    if (gen !== navGeneration.get(tabId)) return;
    // Synthetic NONE label — use has:nouserlabels search
    if (labelId === "NONE") {
      const query = scope ? `has:nouserlabels after:${scope}` : "has:nouserlabels";
      const url = `${base}#search/${encodeURIComponent(query)}`;
      lastExtensionNavHash.set(tabId, urlHash(url));
      chrome.tabs.update(tabId, { url });
      return;
    }
    const label = labels.find(l => l.id === labelId);
    if (!label) return;
    let labelName: string | string[] = label.name;
    if (includeChildren) {
      const descendants = labels.filter(l => l.id !== labelId && l.name.startsWith(label.name + "/"));
      if (descendants.length > 0) labelName = [label.name, ...descendants.map(l => l.name)];
    }
    const url = buildGmailUrl(base, labelName, scope);
    lastExtensionNavHash.set(tabId, urlHash(url));
    chrome.tabs.update(tabId, { url });
  };
  if (labels.length > 0) {
    doNav(labels);
  } else {
    // Labels not yet loaded — load them first, then navigate
    cacheManager.loadLabels().then(() => { doNav(cacheManager.getLabels()); }).catch(() => {});
  }
}

function updateGmailTab(windowId: number, tabId: number | null, tabUrl: string | null): void {
  for (const [, state] of portState) {
    if (state.windowId === windowId) {
      state.gmailTabId = tabId;
      state.gmailTabUrl = tabUrl;
    }
  }
}

function broadcastToWindow(windowId: number, message: Record<string, unknown>): void {
  for (const [port, state] of portState) {
    if (state.windowId === windowId) {
      try { port.postMessage(message); } catch { /* port may be dead */ }
    }
  }
}

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== "sidepanel") return;

  const state: PortState = { returnToInbox: true, onFiltersTab: true, gmailTabId: null, gmailTabUrl: null, windowId: null, lastScopeTimestamp: undefined, lastSelection: null, pushGeneration: 0 };
  portState.set(port, state);

  // Window ID will be set by the "initWindow" message from the side panel

  port.onMessage.addListener((message: { type: string; mode?: string; labelId?: string; includeChildren?: boolean; scope?: string | null; scopeTimestamp?: number | null; returnToInbox?: boolean; onFiltersTab?: boolean; windowId?: number; seq?: number; showStarred?: boolean; showImportant?: boolean; concurrency?: number }) => {
    if (message.type === "initWindow" && message.windowId !== undefined) {
      state.windowId = message.windowId;
      // Capture scope from sidepanel's saved setting so the first orchestrator start uses it
      if (message.scopeTimestamp !== undefined) state.lastScopeTimestamp = message.scopeTimestamp ?? null;
      chrome.tabs.query({ active: true, windowId: message.windowId }).then((tabs) => {
        const tab = tabs[0];
        if (!tab?.id || !tab.url) return;
        if (isGmail(tab.url)) {
          state.gmailTabId = tab.id;
          state.gmailTabUrl = tab.url;
          // Cancel any pending return-to-inbox for this tab (e.g. after service worker restart)
          const pending = pendingReturnToInbox.get(tab.id);
          if (pending !== undefined) { clearTimeout(pending); pendingReturnToInbox.delete(tab.id); }
          const account = gmailAccountPath(tab.url);
          const wasAlreadyRunning = cacheManager.isOrchestratorRunning() && currentAccountPath === account;
          port.postMessage({ type: "resultsReady", accountPath: account });
          startOrchestrator(account, getScopeForWindow(message.windowId));
          // When the orchestrator is already warm, push current counts to the new port so it
          // doesn't have to wait for a future push event (fixes late-connect missing counts).
          if (wasAlreadyRunning) {
            const scopeTimestamp = state.lastScopeTimestamp ?? null;
            // Ensure the orchestrator knows about this port's scope so it gets fetched
            if (scopeTimestamp !== null) cacheManager.requestScopeFetch(scopeTimestamp);
            pushResultsForPort(port, { labelId: null, includeChildren: false, scopeTimestamp });
          }
        } else {
          port.postMessage({ type: "notOnGmail" });
        }
      });
    } else if (message.type === "selectionChanged") {
      const labelId = message.labelId ?? null;
      const includeChildren = message.includeChildren ?? false;
      const scopeTimestamp = message.scopeTimestamp ?? null;
      const scope = message.scope ?? null;
      state.lastSelection = { labelId, includeChildren, scopeTimestamp };
      state.lastScopeTimestamp = scopeTimestamp;
      // Navigate Gmail immediately — independent of cache manager
      if (state.gmailTabId !== null && state.gmailTabUrl) {
        const base = `https://mail.google.com${gmailAccountPath(state.gmailTabUrl)}`;
        if (labelId === null) {
          // Invalidate any pending navigateGmailToLabel callbacks so a stale loadLabels
          // completion doesn't navigate back to the old label after deselection.
          navGeneration.set(state.gmailTabId, (navGeneration.get(state.gmailTabId) ?? 0) + 1);
          const url = buildGmailUrl(base, null, scope);
          lastExtensionNavHash.set(state.gmailTabId, urlHash(url));
          chrome.tabs.update(state.gmailTabId, { url });
        } else {
          // Best-effort navigation with currently available labels
          navigateGmailToLabel(state.gmailTabId, base, labelId, includeChildren, scope);
        }
      }
      // Inform cache manager — it will push results via callback when data is available
      cacheManager.setFilterConfig({ labelId, includeChildren, scopeTimestamp });
    } else if (message.type === "filtersOff") {
      // Navigate Gmail to inbox without changing selection state.
      // Invalidate pending navigateGmailToLabel callbacks so a stale loadLabels
      // completion doesn't override this inbox navigation.
      if (state.gmailTabId !== null) navGeneration.set(state.gmailTabId, (navGeneration.get(state.gmailTabId) ?? 0) + 1);
      if (state.gmailTabId !== null && state.gmailTabUrl) {
        const base = `https://mail.google.com${gmailAccountPath(state.gmailTabUrl)}`;
        const url = `${base}#inbox`;
        lastExtensionNavHash.set(state.gmailTabId, "inbox");
        chrome.tabs.update(state.gmailTabId, { url });
      }
    } else if (message.type === "syncState") {
      if (message.returnToInbox !== undefined) state.returnToInbox = message.returnToInbox;
      if (message.onFiltersTab !== undefined) state.onFiltersTab = message.onFiltersTab;
    } else
    if (message.type === "setPinMode" && (message.mode === "pinned" || message.mode === "autohide-site")) {
      pinMode = message.mode;
      chrome.storage.session.set({ pinMode: message.mode });
    } else if (message.type === "fetchLabels") {
      const fetchSeq = message.seq;
      fetchLabels().then((labels) => {
        cacheManager.setLabels(labels);
        const labelsWithNone = [...labels, { id: "NONE", name: "No user labels", type: "system" }];
        const response: Record<string, unknown> = { type: "labelsReady", labels: labelsWithNone };
        if (fetchSeq !== undefined) response.seq = fetchSeq;
        port.postMessage(response);
      }).catch(() => { port.postMessage({ type: "labelsError" }); });
    } else if (message.type === "syncSettings") {
      const showStarred = !!message.showStarred;
      const showImportant = !!message.showImportant;
      if (typeof message.concurrency === "number" && message.concurrency > 0) cacheManager.setConcurrency(message.concurrency);
      cacheManager.updateSystemLabelSettings(showStarred, showImportant);
      // Wake the orchestrator so it can fetch newly enabled system labels
      if (cacheManager.isOrchestratorRunning()) {
        cacheManager.wakeOrchestrator();
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const s = portState.get(port);
    if (s?.returnToInbox && s.onFiltersTab && s.gmailTabId !== null && s.gmailTabUrl) {
      const tabId = s.gmailTabId;
      const base = `https://mail.google.com${gmailAccountPath(s.gmailTabUrl)}`;
      // Delay return-to-inbox so reconnects after service worker restarts can cancel it
      const timeoutId = setTimeout(() => {
        pendingReturnToInbox.delete(tabId);
        const url = `${base}#inbox`;
        lastExtensionNavHash.set(tabId, "inbox");
        chrome.tabs.update(tabId, { url }).catch(() => {});
      }, 2000);
      pendingReturnToInbox.set(tabId, timeoutId);
    }
    portState.delete(port);
  });
});

// Re-fetch when Gmail tab finishes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tab.windowId === undefined) return;
  // Cancel pending return-to-inbox if the tab navigated (user moved elsewhere during the delay)
  if (changeInfo.url !== undefined) {
    const pending = pendingReturnToInbox.get(tabId);
    if (pending !== undefined) { clearTimeout(pending); pendingReturnToInbox.delete(tabId); }
  }
  // Detect user-initiated Gmail navigation (hash changes not caused by the extension)
  if (changeInfo.url !== undefined && isGmail(changeInfo.url) && portState.size > 0) {
    const lastHash = lastExtensionNavHash.get(tabId);
    const currentHash = urlHash(changeInfo.url);
    if (lastHash && (currentHash === lastHash || currentHash.startsWith(lastHash + "/"))) {
      // Hash matches (or is a sub-path of) what the extension navigated to — not a user action
    } else if (isGmailListView(changeInfo.url)) {
      // User navigated to a different list view — clear stored hash and notify sidepanel
      lastExtensionNavHash.delete(tabId);
      if (tab.windowId !== undefined) broadcastToWindow(tab.windowId, { type: "userNavigated" });
    }
  }
  if (portState.size === 0) return;
  if (changeInfo.status === "complete") {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab?.id === tabId) {
      if (isGmail(tab.url)) {
        const account = gmailAccountPath(tab.url);
        updateGmailTab(tab.windowId, tabId, tab.url ?? null);
        const currentHash = urlHash(tab.url ?? "");
        const lastHash = lastExtensionNavHash.get(tabId);
        if (!lastHash || (currentHash !== lastHash && !currentHash.startsWith(lastHash + "/"))) {
          broadcastToWindow(tab.windowId, { type: "resultsReady", accountPath: account });
        }
        startOrchestrator(account, getScopeForWindow(tab.windowId));
      } else {
        updateGmailTab(tab.windowId, null, null);
        broadcastToWindow(tab.windowId, { type: "notOnGmail" });
        if (pinMode !== "pinned") closePanel(tabId);
      }
    }
  } else if (changeInfo.url !== undefined && !isGmail(changeInfo.url) && pinMode !== "pinned") {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab?.id === tabId) closePanel(tabId);
  }
});

// Re-fetch when switching to a Gmail tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (portState.size === 0) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (isGmail(tab.url)) {
      const account = gmailAccountPath(tab.url);
      updateGmailTab(activeInfo.windowId, activeInfo.tabId, tab.url ?? null);
      broadcastToWindow(activeInfo.windowId, { type: "resultsReady", accountPath: account });
      startOrchestrator(account, getScopeForWindow(activeInfo.windowId));
    } else {
      updateGmailTab(activeInfo.windowId, null, null);
      broadcastToWindow(activeInfo.windowId, { type: "notOnGmail" });
      if (pinMode !== "pinned") closePanel(activeInfo.tabId);
    }
  } catch { /* tab may not exist */ }
});

export function buildGmailUrl(base: string, labelName: string | string[] | null, scope: string | null): string {
  const query = buildSearchQuery(labelName, scope);
  if (!query) return `${base}#all`;
  // Single "in:..." clause with no other filters — use direct hash navigation
  const parts = query.split(" ");
  if (parts.length === 1 && parts[0].startsWith("in:")) {
    const loc = parts[0].slice(3);
    const hashMap: Record<string, string> = { inbox: "inbox", sent: "sent", starred: "starred", important: "imp" };
    return `${base}#${hashMap[loc] ?? loc}`;
  }
  return `${base}#search/${encodeURIComponent(query)}`;
}

function hasPortForWindow(windowId: number): boolean {
  for (const [, state] of portState) {
    if (state.windowId === windowId) return true;
  }
  return false;
}

// Toggle side panel: close if open in this window, open if closed.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (tab.windowId !== undefined && hasPortForWindow(tab.windowId)) {
    await closePanel(tab.id);
  } else {
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (err) { console.warn("Could not open side panel:", err); }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-sidepanel") return;
  if (portState.size === 0) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await closePanel(tab.id);
});

/** Exported for testing — reset cache state */
export function _resetCacheState(): void {
  cacheManager.stop();
  currentAccountPath = null;
  portState.clear();
  chrome.alarms.clear(CACHE_ALARM_NAME).catch(() => {});
}

/** Exported for testing — access the cache manager instance */
export { cacheManager };
