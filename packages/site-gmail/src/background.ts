import type { PinMode } from "@core/types.js";
import { fetchLabels, type GmailLabel, buildSearchQuery } from "./gmail-api.js";
import { CacheManager, type CacheProgress } from "./cache-manager.js";

const GMAIL_PATTERN = /^https:\/\/mail\.google\.com\//;

interface PortSelection { labelId: string | null; includeChildren: boolean; scopeTimestamp: number | null; seq: number }
interface PortState { returnToInbox: boolean; onFiltersTab: boolean; gmailTabId: number | null; gmailTabUrl: string | null; windowId: number | null; lastSelection: PortSelection | null; lastScopeTimestamp: number | null | undefined; resultGeneration: number; countsGeneration: number }
const portState = new Map<chrome.runtime.Port, PortState>();
const pendingReturnToInbox = new Map<number, ReturnType<typeof setTimeout>>();
/** Last hash fragment the extension navigated each tab to via selectionChanged — used to suppress userNavigated for our own navigations. */
const lastExtensionNavHash = new Map<number, string>();
let pinMode: PinMode = "pinned";

const cacheManager = new CacheManager();
let currentAccountPath: string | null = null;
const CACHE_ALARM_NAME = "cache-keepalive";

/** Push updated label result and counts to all connected sidepanels. Each port is queried using its own last selection so multi-window use gets correct results. */
function pushUpdatedResults(): void {
  // Ensure the orchestrator will fetch all scope timestamps needed by connected ports,
  // not just the global filterConfig scope (fixes multi-window post-refresh starvation).
  for (const [, s] of portState) {
    const ts = s.lastSelection?.scopeTimestamp ?? s.lastScopeTimestamp;
    if (ts !== null && ts !== undefined) cacheManager.requestScopeFetch(ts);
  }
  for (const [port, state] of portState) {
    const sel = state.lastSelection;
    if (sel?.labelId) {
      const { labelId, includeChildren, scopeTimestamp, seq } = sel;
      const myResultGen = ++state.resultGeneration;
      cacheManager.waitForScopeReady(scopeTimestamp).then((scopeReady) => {
        if (!scopeReady) return Promise.resolve(undefined);
        if (state.resultGeneration !== myResultGen) return Promise.resolve(undefined);
        return cacheManager.queryLabel(labelId, includeChildren, scopeTimestamp);
      }).then((result) => {
        if (!result) return;
        if (state.resultGeneration !== myResultGen) return;
        try { port.postMessage({ type: "labelResult", ...result, seq }); } catch { /* port may be dead */ }
      }).catch(() => {});
    }
    const scopeAtCall = state.lastScopeTimestamp;
    const scopeForApi = scopeAtCall ?? null;
    const myCountsGen = ++state.countsGeneration;
    cacheManager.waitForScopeReady(scopeForApi).then((scopeReady) => {
      if (!scopeReady && scopeForApi !== null) return Promise.resolve(null);
      if (state.lastScopeTimestamp !== scopeAtCall) return Promise.resolve(null);
      if (state.countsGeneration !== myCountsGen) return Promise.resolve(null);
      return cacheManager.getLabelCounts(undefined, scopeForApi);
    }).then((counts) => {
      if (state.lastScopeTimestamp !== scopeAtCall) return;
      if (state.countsGeneration !== myCountsGen) return;
      try { port.postMessage({ type: "countsReady", counts }); } catch { /* port may be dead */ }
    }).catch(() => {});
  }
}

cacheManager.setProgressCallback((progress: CacheProgress) => {
  for (const [port] of portState) {
    try { port.postMessage({ type: "cacheState", ...progress }); } catch { /* port may be dead */ }
  }
  if (progress.phase === "complete") {
    // Schedule a future wake-up for incremental refresh — only if no alarm is already pending
    chrome.alarms.get(CACHE_ALARM_NAME).then(existing => {
      if (!existing) chrome.alarms.create(CACHE_ALARM_NAME, { delayInMinutes: 11 });
    }).catch(() => {});
    pushUpdatedResults();
  } else if (progress.phase === "labels") {
    // Push results as each label is indexed so the sidepanel shows counts
    // progressively during the initial build (especially for the selected label)
    pushUpdatedResults();
  } else if (progress.phase === "expanding") {
    // Keep service worker alive during background expansion
    chrome.alarms.create(CACHE_ALARM_NAME, { periodInMinutes: 0.4 });
    if (progress.labelsTotal === 0) {
      // Tier completion — push updated counts
      pushUpdatedResults();
    }
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
  currentAccountPath = accountPath;
  // Persist account path so the alarm handler can restart after SW suspension
  chrome.storage.session.set({ accountPath });
  // Set initial filter config from scope before starting so decide() knows about it
  if (scopeTimestamp !== undefined) {
    cacheManager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: scopeTimestamp ?? null });
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

  const state: PortState = { returnToInbox: true, onFiltersTab: true, gmailTabId: null, gmailTabUrl: null, windowId: null, lastSelection: null, lastScopeTimestamp: undefined, resultGeneration: 0, countsGeneration: 0 };
  portState.set(port, state);

  // Window ID will be set by the "initWindow" message from the side panel

  port.onMessage.addListener((message: { type: string; mode?: string; labelId?: string; includeChildren?: boolean; scope?: string | null; scopeTimestamp?: number | null; returnToInbox?: boolean; onFiltersTab?: boolean; windowId?: number; seq?: number; showStarred?: boolean; showImportant?: boolean }) => {
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
          port.postMessage({ type: "resultsReady", accountPath: account });
          startOrchestrator(account, getScopeForWindow(message.windowId));
        } else {
          port.postMessage({ type: "notOnGmail" });
        }
      });
    } else if (message.type === "selectionChanged") {
      const seq = message.seq;
      const labelId = message.labelId ?? null;
      const includeChildren = message.includeChildren ?? false;
      const scopeTimestamp = message.scopeTimestamp ?? null;
      const scope = message.scope ?? null;
      state.lastSelection = { labelId, includeChildren, scopeTimestamp, seq: seq ?? 0 };
      state.lastScopeTimestamp = scopeTimestamp;
      // Update orchestrator filter config — wakes it to fetch what's needed
      cacheManager.setFilterConfig({ labelId, includeChildren, scopeTimestamp });
      if (labelId === null) {
        // Deselection: navigate to #all (or scoped search) and respond with empty result
        if (state.gmailTabId !== null && state.gmailTabUrl) {
          const base = `https://mail.google.com${gmailAccountPath(state.gmailTabUrl)}`;
          const url = buildGmailUrl(base, null, scope);
          lastExtensionNavHash.set(state.gmailTabId, urlHash(url));
          chrome.tabs.update(state.gmailTabId, { url });
        }
        port.postMessage({ type: "labelResult", labelId: null, count: 0, coLabelCounts: {}, seq });
      } else {
        // Selection: await cache readiness, navigate Gmail, query cache, respond with result
        const selectionSeq = seq ?? 0;
        const myResultGen = ++state.resultGeneration;
        cacheManager.whenReady().then(async () => {
          if (state.lastSelection?.seq !== selectionSeq) return;
          if (state.gmailTabId !== null && state.gmailTabUrl) {
            let labels = cacheManager.getLabels();
            if (labels.length === 0) {
              try { await cacheManager.loadLabels(); labels = cacheManager.getLabels(); } catch { /* keep empty — navigation will gracefully fall back */ }
            }
            if (state.lastSelection?.seq !== selectionSeq) return;
            const label = labels.find(l => l.id === labelId);
            if (label) {
              let labelName: string | string[] = label.name;
              if (includeChildren) {
                const descendants = labels.filter(l => l.id !== labelId && l.name.startsWith(label.name + "/"));
                if (descendants.length > 0) labelName = [label.name, ...descendants.map(l => l.name)];
              }
              const base = `https://mail.google.com${gmailAccountPath(state.gmailTabUrl!)}`;
              const url = buildGmailUrl(base, labelName, scope);
              lastExtensionNavHash.set(state.gmailTabId, urlHash(url));
              chrome.tabs.update(state.gmailTabId, { url });
            }
          }
          if (includeChildren && cacheManager.getLabels().length === 0) {
            return { labelId, count: 0, coLabelCounts: {}, error: true } as { labelId: string; count: number; coLabelCounts: Record<string, number>; error: boolean };
          }
          const scopeReady = await cacheManager.waitForScopeReady(scopeTimestamp);
          if (!scopeReady) return { labelId, count: 0, coLabelCounts: {}, error: true } as { labelId: string; count: number; coLabelCounts: Record<string, number>; error: boolean };
          if (state.lastSelection?.seq !== selectionSeq) return undefined;
          return cacheManager.queryLabel(labelId, includeChildren, scopeTimestamp);
        }).then((result) => {
          if (state.resultGeneration !== myResultGen) return;
          port.postMessage({ type: "labelResult", ...result, seq });
        }).catch(() => {
          if (state.resultGeneration !== myResultGen) return;
          port.postMessage({ type: "labelResult", labelId, count: 0, coLabelCounts: {}, error: true, seq });
        });
      }
    } else if (message.type === "filtersOff") {
      // Navigate Gmail to inbox without changing selection state
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
        const response: Record<string, unknown> = { type: "labelsReady", labels };
        if (fetchSeq !== undefined) response.seq = fetchSeq;
        port.postMessage(response);
      }).catch(() => { port.postMessage({ type: "labelsError" }); });
    } else if (message.type === "syncSettings") {
      const showStarred = !!message.showStarred;
      const showImportant = !!message.showImportant;
      cacheManager.updateSystemLabelSettings(showStarred, showImportant);
      // Wake the orchestrator so it can fetch newly enabled system labels
      if (cacheManager.isOrchestratorRunning()) {
        cacheManager.wakeOrchestrator();
      }
    } else if (message.type === "fetchCounts") {
      const fetchSeq = message.seq;
      state.lastScopeTimestamp = message.scopeTimestamp ?? null;
      const scopeTs = message.scopeTimestamp ?? null;
      // Update orchestrator filter config for scope changes
      cacheManager.setFilterConfig({ ...cacheManager.getFilterConfig(), scopeTimestamp: scopeTs });
      const myCountsGen = ++state.countsGeneration;
      const sendCountsReady = (counts: Record<string, { own: number; inclusive: number }> | null): void => {
        const response: Record<string, unknown> = { type: "countsReady", counts };
        if (fetchSeq !== undefined) response.seq = fetchSeq;
        try { port.postMessage(response); } catch { /* port may be closed */ }
      };
      cacheManager.waitForScopeReady(scopeTs).then((scopeReady) => {
        if (!scopeReady && scopeTs !== null) return Promise.resolve(null);
        if (state.countsGeneration !== myCountsGen) return Promise.resolve(null);
        return cacheManager.getLabelCounts(undefined, scopeTs);
      }).then((counts) => {
        if (state.countsGeneration !== myCountsGen) return;
        sendCountsReady(counts);
      }).catch(() => {
        sendCountsReady(null);
      });
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
