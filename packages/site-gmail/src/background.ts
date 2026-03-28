import type { PinMode } from "@core/types.js";

const GMAIL_PATTERN = /^https:\/\/mail\.google\.com\//;

let sidePanelOpen = false;
let pinMode: PinMode = "pinned";

// Let Chrome open the side panel on action click; we handle close via toggle
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

function isGmail(url: string | undefined): boolean {
  return url !== undefined && GMAIL_PATTERN.test(url);
}

async function closePanel(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.sidePanel.close({ windowId: tab.windowId });
  } catch (err) {
    console.warn("Could not close side panel:", err);
  }
}

// action.onClicked does not fire when openPanelOnActionClick is true.
// Chrome handles open automatically; we only need close via keyboard shortcut.

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== "sidepanel") return;
  sidePanelOpen = true;
  port.onDisconnect.addListener(() => {
    sidePanelOpen = false;
  });
});

// Auto-hide: close panel when navigating away from Gmail
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!sidePanelOpen || pinMode === "pinned") return;
  if (changeInfo.url === undefined) return;
  if (!isGmail(changeInfo.url)) {
    closePanel(tabId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!sidePanelOpen || pinMode === "pinned") return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isGmail(tab.url)) {
      closePanel(activeInfo.tabId);
    }
  } catch { /* tab may not exist */ }
});

// Handle pin mode messages from side panel
chrome.runtime.onMessage.addListener((message: { type: string; mode?: string }) => {
  if (message.type === "setPinMode" && (message.mode === "pinned" || message.mode === "autohide-site")) {
    pinMode = message.mode;
  }
  return undefined;
});

// Keyboard shortcut to toggle side panel
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-sidepanel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    if (sidePanelOpen) await closePanel(tab.id);
    else {
      try { await chrome.sidePanel.open({ tabId: tab.id }); } catch { /* ignore */ }
    }
  }
});
