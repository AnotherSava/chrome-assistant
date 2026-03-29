import type { PinMode } from "@core/types.js";
import { fetchLabels } from "./gmail-api.js";

const GMAIL_PATTERN = /^https:\/\/mail\.google\.com\//;

const activePorts = new Set<chrome.runtime.Port>();
let pinMode: PinMode = "pinned";

// Restore pinMode from session storage (survives service worker restarts)
chrome.storage.session.get("pinMode", (result) => {
  if (result.pinMode === "pinned" || result.pinMode === "autohide-site") {
    pinMode = result.pinMode;
  }
});

// Let Chrome open the side panel on action click; we handle close via toggle
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

function isGmail(url: string | undefined): boolean {
  return url !== undefined && GMAIL_PATTERN.test(url);
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

function broadcast(message: Record<string, unknown>): void {
  for (const port of activePorts) {
    try { port.postMessage(message); } catch { /* port may be dead */ }
  }
}

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== "sidepanel") return;
  activePorts.add(port);

  chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !tab.url) return;
    if (isGmail(tab.url)) {
      port.postMessage({ type: "resultsReady" });
    } else {
      port.postMessage({ type: "notOnGmail" });
    }
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
  });
});

// Re-fetch when Gmail tab finishes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (activePorts.size === 0) return;
  if (changeInfo.status === "complete") {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id === tabId) {
      if (isGmail(tab.url)) {
        broadcast({ type: "resultsReady" });
      } else {
        broadcast({ type: "notOnGmail" });
        if (pinMode !== "pinned") closePanel(tabId);
      }
    }
  } else if (changeInfo.url !== undefined && !isGmail(changeInfo.url) && pinMode !== "pinned") {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id === tabId) closePanel(tabId);
  }
});

// Re-fetch when switching to a Gmail tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (activePorts.size === 0) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (isGmail(tab.url)) {
      broadcast({ type: "resultsReady" });
    } else {
      broadcast({ type: "notOnGmail" });
      if (pinMode !== "pinned") closePanel(activeInfo.tabId);
    }
  } catch { /* tab may not exist */ }
});

// Handle messages from side panel
function buildGmailUrl(base: string, location: string | undefined, labelName: string | null, scope: string | null): string {
  const parts: string[] = [];
  if (labelName) parts.push(`label:"${labelName.replace(/"/g, "").replace(/[/ ]/g, "-").toLowerCase()}"`);
  const loc = location ?? "inbox";
  if (loc !== "all") parts.push(`in:${loc}`);
  if (scope) parts.push(`after:${scope}`);
  if (parts.length === 0) return `${base}#${loc}`;
  // Single "in:inbox" with no other filters — use direct navigation instead of search
  if (parts.length === 1 && parts[0].startsWith("in:")) return `${base}#${loc}`;
  return `${base}#search/${encodeURIComponent(parts.join(" "))}`;
}

chrome.runtime.onMessage.addListener((message: { type: string; mode?: string; labelName?: string | null; scope?: string | null; location?: string }, _sender, sendResponse) => {
  if (message.type === "setPinMode" && (message.mode === "pinned" || message.mode === "autohide-site")) {
    pinMode = message.mode;
    chrome.storage.session.set({ pinMode: message.mode });
  } else if (message.type === "applyFilters") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id || !isGmail(tab.url)) return;
      const base = `https://mail.google.com${gmailAccountPath(tab.url)}`;
      chrome.tabs.update(tab.id, { url: buildGmailUrl(base, message.location, message.labelName ?? null, message.scope ?? null) });
    });
  } else if (message.type === "fetchLabels") {
    fetchLabels().then((labels) => sendResponse({ labels })).catch(() => sendResponse({ labels: [] }));
    return true;
  }
  return undefined;
});

// Keyboard shortcut to toggle side panel
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-sidepanel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    if (activePorts.size > 0) await closePanel(tab.id);
    else {
      try { await chrome.sidePanel.open({ tabId: tab.id }); } catch { /* ignore */ }
    }
  }
});
