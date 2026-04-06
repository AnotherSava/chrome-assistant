import type { PinMode } from "@core/types.js";
import { fetchLabels, type GmailLabel, buildSearchQuery } from "./gmail-api.js";
import { CacheManager, type CacheProgress } from "./cache-manager.js";

const GMAIL_PATTERN = /^https:\/\/mail\.google\.com\//;

interface PortState { returnToInbox: boolean; onFiltersTab: boolean; gmailTabId: number | null; gmailTabUrl: string | null; windowId: number | null }
const portState = new Map<chrome.runtime.Port, PortState>();
const pendingReturnToInbox = new Map<number, ReturnType<typeof setTimeout>>();
/** Last hash fragment the extension navigated each tab to via applyFilters — used to suppress userNavigated for our own navigations. */
const lastExtensionNavHash = new Map<number, string>();
let pinMode: PinMode = "pinned";

const cacheManager = new CacheManager();
let cacheStarted = false;
let currentAccountPath: string | null = null;
let cacheGeneration = 0;
const CACHE_ALARM_NAME = "cache-keepalive";

cacheManager.setProgressCallback((progress: CacheProgress) => {
  for (const [port] of portState) {
    try { port.postMessage({ type: "cacheState", ...progress }); } catch { /* port may be dead */ }
  }
  if (progress.phase === "complete") {
    chrome.alarms.clear(CACHE_ALARM_NAME).catch(() => {});
  }
});

// Keep service worker alive during active cache fetch
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CACHE_ALARM_NAME) {
    // No-op — alarm firing keeps the SW alive
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

export function startCacheIfNeeded(accountPath: string): void {
  if (cacheStarted && currentAccountPath === accountPath) return;
  currentAccountPath = accountPath;
  cacheStarted = true;
  const gen = ++cacheGeneration;
  chrome.alarms.create(CACHE_ALARM_NAME, { periodInMinutes: 0.4 });
  cacheManager.startFetch(accountPath).then(() => {
    if (gen === cacheGeneration) cacheStarted = false;
  }).catch((err) => {
    console.warn("Cache fetch failed:", err);
    if (gen === cacheGeneration) {
      cacheStarted = false;
      chrome.alarms.clear(CACHE_ALARM_NAME).catch(() => {});
    }
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
  // Search views
  if (hash.startsWith("search/")) return true;
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

  const state: PortState = { returnToInbox: true, onFiltersTab: true, gmailTabId: null, gmailTabUrl: null, windowId: null };
  portState.set(port, state);

  // Window ID will be set by the "initWindow" message from the side panel

  port.onMessage.addListener((message: { type: string; mode?: string; labelName?: string | null; labelId?: string; scope?: string | null; scopeTimestamp?: number | null; location?: string; returnToInbox?: boolean; onFiltersTab?: boolean; windowId?: number; query?: string; pageToken?: string; fetchId?: string; seq?: number }) => {
    if (message.type === "initWindow" && message.windowId !== undefined) {
      state.windowId = message.windowId;
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
          startCacheIfNeeded(account);
        } else {
          port.postMessage({ type: "notOnGmail" });
        }
      });
    } else if (message.type === "queryLabel" && message.labelId) {
      const seq = message.seq;
      cacheManager.queryLabel(message.labelId, message.location, message.scopeTimestamp ?? null).then((result) => { port.postMessage({ type: "labelResult", ...result, seq }); }).catch(() => { port.postMessage({ type: "labelResult", labelId: message.labelId, count: 0, coLabels: [], error: true, seq }); });
    } else if (message.type === "syncState") {
      if (message.returnToInbox !== undefined) state.returnToInbox = message.returnToInbox;
      if (message.onFiltersTab !== undefined) state.onFiltersTab = message.onFiltersTab;
    } else
    if (message.type === "setPinMode" && (message.mode === "pinned" || message.mode === "autohide-site")) {
      pinMode = message.mode;
      chrome.storage.session.set({ pinMode: message.mode });
    } else if (message.type === "applyFilters") {
      if (state.gmailTabId !== null && state.gmailTabUrl) {
        const base = `https://mail.google.com${gmailAccountPath(state.gmailTabUrl)}`;
        const url = buildGmailUrl(base, message.location, message.labelName ?? null, message.scope ?? null);
        lastExtensionNavHash.set(state.gmailTabId, urlHash(url));
        chrome.tabs.update(state.gmailTabId, { url });
      }
    } else if (message.type === "fetchLabels") {
      fetchLabels().then((labels) => { port.postMessage({ type: "labelsReady", labels }); }).catch(() => { port.postMessage({ type: "labelsError" }); });
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
  // This must run even when no panels are open, since the pending timeout was set on disconnect.
  if (changeInfo.url !== undefined) {
    const pending = pendingReturnToInbox.get(tabId);
    if (pending !== undefined) { clearTimeout(pending); pendingReturnToInbox.delete(tabId); }
  }
  // Detect user-initiated Gmail navigation (hash changes not caused by the extension)
  if (changeInfo.url !== undefined && isGmail(changeInfo.url) && portState.size > 0) {
    const lastHash = lastExtensionNavHash.get(tabId);
    const currentHash = urlHash(changeInfo.url);
    if (lastHash && currentHash === lastHash) {
      // Hash matches what the extension navigated to — not a user action
    } else {
      lastExtensionNavHash.delete(tabId);
      if (isGmailListView(changeInfo.url) && tab.windowId !== undefined) {
        broadcastToWindow(tab.windowId, { type: "userNavigated" });
      }
    }
  }
  if (portState.size === 0) return;
  if (changeInfo.status === "complete") {
    // Only react if this tab is the active tab in its window
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab?.id === tabId) {
      if (isGmail(tab.url)) {
        const account = gmailAccountPath(tab.url);
        updateGmailTab(tab.windowId, tabId, tab.url ?? null);
        broadcastToWindow(tab.windowId, { type: "resultsReady", accountPath: account });
        startCacheIfNeeded(account);
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
      startCacheIfNeeded(account);
    } else {
      updateGmailTab(activeInfo.windowId, null, null);
      broadcastToWindow(activeInfo.windowId, { type: "notOnGmail" });
      if (pinMode !== "pinned") closePanel(activeInfo.tabId);
    }
  } catch { /* tab may not exist */ }
});

// Handle messages from side panel
export function buildGmailUrl(base: string, location: string | undefined, labelName: string | null, scope: string | null): string {
  const loc = location ?? "inbox";
  const query = buildSearchQuery(location, labelName, scope);
  if (!query) return `${base}#${loc}`;
  // Single "in:location" with no other filters — use direct navigation instead of search
  const parts = query.split(" ");
  if (parts.length === 1 && parts[0].startsWith("in:")) return `${base}#${loc}`;
  return `${base}#search/${encodeURIComponent(query)}`;
}

function hasPortForWindow(windowId: number): boolean {
  for (const [, state] of portState) {
    if (state.windowId === windowId) return true;
  }
  return false;
}

// Toggle side panel: close if open in this window, open if closed.
// sidePanel.open() must be called synchronously during the user gesture — no await before it.
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
  cacheStarted = false;
  currentAccountPath = null;
  cacheGeneration = 0;
}

/** Exported for testing — access the cache manager instance */
export { cacheManager };
