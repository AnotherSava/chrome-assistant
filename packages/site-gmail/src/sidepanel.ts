import { renderHelp } from "./help.js";
import { ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";
import { loadSetting, saveSetting } from "@core/settings.js";
import type { PinMode, GmailLabel } from "@core/types.js";
import * as searchTab from "./search-tab.js";

// Re-export for tests
export { scopeToTimestamp, setIncludeChildren, setShowCounts, setShowStarred, setShowImportant, setScopeValue } from "./search-tab.js";

let currentTab: "summary" | "search" = "search";
let onGmailPage = false;
let currentAccountPath: string | null = null;

// ---------------------------------------------------------------------------
// Migration: remove old localStorage cache keys (replaced by IndexedDB)
// ---------------------------------------------------------------------------

const OLD_CACHE_KEYS = ["ca_msg_cache_labels", "ca_msg_cache_messages", "ca_msg_cache_oldest", "ca_msg_cache_broad_oldest", "ca_msg_cache_complete", "ca_msg_cache_label_oldest", "ca_msg_cache_newest", "ca_msg_cache_ids", "ca_msg_cache_account"];
for (const key of OLD_CACHE_KEYS) localStorage.removeItem(key);

// ---------------------------------------------------------------------------
// Zoom (Ctrl+/- and Ctrl+0)
// ---------------------------------------------------------------------------

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const KEY_ZOOM = "ca_zoom_levels";
const ZOOM_DEFAULT = 1.0;

let zoomLevel = ZOOM_DEFAULT;
let zoomFadeTimeout: ReturnType<typeof setTimeout> | undefined;
let currentZoomContext = "help";

function switchZoomContext(context: string): void {
  currentZoomContext = context;
  const levels = loadSetting<Record<string, number>>(KEY_ZOOM, {});
  const stored = levels[context];
  zoomLevel = stored !== undefined && stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : ZOOM_DEFAULT;
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.style.zoom = String(zoomLevel);
}

function applyZoom(): void {
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.style.zoom = String(zoomLevel);
  const levels = loadSetting<Record<string, number>>(KEY_ZOOM, {});
  levels[currentZoomContext] = zoomLevel;
  saveSetting(KEY_ZOOM, levels);
  const indicator = document.getElementById("zoom-indicator");
  if (indicator) {
    indicator.textContent = `${Math.round(zoomLevel * 100)}%`;
    indicator.classList.add("visible");
    clearTimeout(zoomFadeTimeout);
    zoomFadeTimeout = setTimeout(() => indicator.classList.remove("visible"), 1200);
  }
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    zoomLevel = Math.min(ZOOM_MAX, Math.round((zoomLevel + ZOOM_STEP) * 10) / 10);
    applyZoom();
  } else if (e.key === "-") {
    e.preventDefault();
    zoomLevel = Math.max(ZOOM_MIN, Math.round((zoomLevel - ZOOM_STEP) * 10) / 10);
    applyZoom();
  } else if (e.key === "0") {
    e.preventDefault();
    zoomLevel = 1.0;
    applyZoom();
  }
});

document.getElementById("btn-zoom-out")?.addEventListener("click", () => {
  zoomLevel = Math.max(ZOOM_MIN, Math.round((zoomLevel - ZOOM_STEP) * 10) / 10);
  applyZoom();
});
document.getElementById("btn-zoom-in")?.addEventListener("click", () => {
  zoomLevel = Math.min(ZOOM_MAX, Math.round((zoomLevel + ZOOM_STEP) * 10) / 10);
  applyZoom();
});

// ---------------------------------------------------------------------------
// Auto-hide (pin mode)
// ---------------------------------------------------------------------------

const KEY_PIN_MODE = "ca_pin_mode";
const PIN_MODE_DEFAULT: PinMode = "pinned";
let currentPinMode: PinMode = loadSetting(KEY_PIN_MODE, PIN_MODE_DEFAULT);
let pinDropdownOpen = false;

const PIN_ICONS: Record<PinMode, string> = { "pinned": ICON_PANEL, "autohide-site": ICON_PANEL_1 };
const PIN_LABELS: Record<PinMode, string> = { "pinned": "Never", "autohide-site": "Leaving Gmail" };
const PIN_ORDER: PinMode[] = ["pinned", "autohide-site"];

function updatePinButtonIcon(): void {
  const btn = document.getElementById("btn-pin");
  if (btn) btn.innerHTML = PIN_ICONS[currentPinMode];
}

function closePinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  dropdown.style.display = "none";
  pinDropdownOpen = false;
}

function selectPinMode(mode: PinMode): void {
  currentPinMode = mode;
  saveSetting(KEY_PIN_MODE, mode);
  updatePinButtonIcon();
  closePinDropdown();
  if (activePort) activePort.postMessage({ type: "setPinMode", mode });
}

function buildPinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";
  const header = document.createElement("div");
  header.className = "dropdown-header";
  header.textContent = "When side panel hides:";
  dropdown.appendChild(header);
  for (const mode of PIN_ORDER) {
    const isActive = mode === currentPinMode;
    const option = document.createElement("div");
    option.className = "pin-option" + (isActive ? " active" : "");
    option.dataset.mode = mode;
    option.innerHTML = PIN_ICONS[mode] + "<span>" + PIN_LABELS[mode] + "</span>";
    dropdown.appendChild(option);
    option.addEventListener("mouseover", () => { dropdown.querySelectorAll(".pin-option").forEach((el) => el.classList.remove("highlight")); option.classList.add("highlight"); });
    option.addEventListener("mouseout", () => { option.classList.remove("highlight"); });
    option.addEventListener("mouseup", (e: MouseEvent) => { e.stopPropagation(); if (isActive) { closePinDropdown(); return; } selectPinMode(mode); });
  }
  const divider = document.createElement("div");
  divider.className = "pin-divider";
  dropdown.appendChild(divider);
  const link = document.createElement("span");
  link.className = "pin-shortcut-link";
  link.textContent = "Set hide/show shortcut";
  chrome.commands.getAll((commands: chrome.commands.Command[]) => { const cmd = commands.find((c) => c.name === "toggle-sidepanel"); if (cmd?.shortcut) link.textContent = `Change hide/show shortcut (${cmd.shortcut})`; });
  link.addEventListener("mouseup", (e: MouseEvent) => { openShortcutsPage(e); closePinDropdown(); });
  dropdown.appendChild(link);
}

function openPinDropdown(): void {
  const dropdown = document.getElementById("pin-dropdown");
  if (!dropdown) return;
  closeDisplayPanel();
  buildPinDropdown();
  dropdown.style.display = "";
  pinDropdownOpen = true;
}

const btnPin = document.getElementById("btn-pin");
if (btnPin) {
  btnPin.onmousedown = (e: MouseEvent) => { e.preventDefault(); if (pinDropdownOpen) closePinDropdown(); else openPinDropdown(); };
  updatePinButtonIcon();
}

document.addEventListener("mouseup", (e: MouseEvent) => {
  if (!pinDropdownOpen) return;
  const dropdown = document.getElementById("pin-dropdown");
  const btn = document.getElementById("btn-pin");
  if (dropdown && !dropdown.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) closePinDropdown();
});


// ---------------------------------------------------------------------------
// Display settings
// ---------------------------------------------------------------------------

const KEY_RETURN_TO_INBOX = "ca_return_to_inbox";
let returnToInbox: boolean = loadSetting(KEY_RETURN_TO_INBOX, true);
let displayPanelOpen = false;

function closeDisplayPanel(): void {
  const panel = document.getElementById("display-panel");
  if (panel) panel.style.display = "none";
  displayPanelOpen = false;
}

function buildDisplayPanel(): void {
  const panel = document.getElementById("display-panel");
  if (!panel) return;
  const ds = searchTab.getDisplaySettings();
  const colOptions = [1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === ds.labelColumns ? " selected" : ""}>${n}</option>`).join("");
  const concurrencyOptions = [1, 3, 5, 10, 20].map((n) => `<option value="${n}"${n === ds.concurrency ? " selected" : ""}>${n}</option>`).join("");
  panel.innerHTML = `<div class="display-row"><label>Columns</label><select id="col-select">${colOptions}</select></div><div class="display-row"><input type="checkbox" id="return-inbox-check"${returnToInbox ? " checked" : ""}><label for="return-inbox-check">Return to Inbox when Search tab closes</label></div><div class="display-row"><input type="checkbox" id="include-children-check"${ds.includeChildren ? " checked" : ""}><label for="include-children-check">Include sub-labels when selecting a parent</label></div><div class="display-row"><input type="checkbox" id="show-counts-check"${ds.showCounts ? " checked" : ""}><label for="show-counts-check">Show email counts</label></div><div class="display-row"><input type="checkbox" id="show-starred-check"${ds.showStarred ? " checked" : ""}><label for="show-starred-check">Show Starred</label></div><div class="display-row"><input type="checkbox" id="show-important-check"${ds.showImportant ? " checked" : ""}><label for="show-important-check">Show Important</label></div><div class="display-row"><input type="checkbox" id="show-cache-progress-check"${ds.showCacheProgress ? " checked" : ""}><label for="show-cache-progress-check">Show background cache progress</label></div><div class="display-row"><label>API concurrency</label><select id="concurrency-select">${concurrencyOptions}</select></div>`;
  const colSelect = document.getElementById("col-select") as HTMLSelectElement;
  colSelect.addEventListener("change", () => {
    searchTab.setLabelColumns(parseInt(colSelect.value, 10));
    if (currentTab === "search") searchTab.loadLabels();
  });
  const returnCheck = document.getElementById("return-inbox-check") as HTMLInputElement;
  returnCheck.addEventListener("change", () => {
    returnToInbox = returnCheck.checked;
    saveSetting(KEY_RETURN_TO_INBOX, returnToInbox);
    syncState();
  });
  const childrenCheck = document.getElementById("include-children-check") as HTMLInputElement;
  childrenCheck.addEventListener("change", () => {
    searchTab.setIncludeChildren(childrenCheck.checked);
  });
  const countsCheck = document.getElementById("show-counts-check") as HTMLInputElement;
  countsCheck.addEventListener("change", () => {
    searchTab.setShowCounts(countsCheck.checked);
    if (countsCheck.checked) {
      searchTab.loadLabels(true);
    } else if (currentTab === "search") {
      searchTab.loadLabels();
    }
  });
  const starredCheck = document.getElementById("show-starred-check") as HTMLInputElement;
  starredCheck.addEventListener("change", () => {
    searchTab.setShowStarred(starredCheck.checked);
    syncSettings();
  });
  const importantCheck = document.getElementById("show-important-check") as HTMLInputElement;
  importantCheck.addEventListener("change", () => {
    searchTab.setShowImportant(importantCheck.checked);
    syncSettings();
  });
  const cacheProgressCheck = document.getElementById("show-cache-progress-check") as HTMLInputElement;
  cacheProgressCheck.addEventListener("change", () => {
    searchTab.setShowCacheProgress(cacheProgressCheck.checked);
  });
  const concurrencySelect = document.getElementById("concurrency-select") as HTMLSelectElement;
  concurrencySelect.addEventListener("change", () => {
    searchTab.setConcurrency(parseInt(concurrencySelect.value, 10));
    syncSettings();
  });
}

const btnDisplay = document.getElementById("btn-display");
if (btnDisplay) {
  btnDisplay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (displayPanelOpen) {
      closeDisplayPanel();
    } else {
      closePinDropdown();
      buildDisplayPanel();
      const panel = document.getElementById("display-panel");
      if (panel) panel.style.display = "";
      displayPanelOpen = true;
    }
  });
}

document.addEventListener("click", (e) => {
  if (displayPanelOpen) {
    const panel = document.getElementById("display-panel");
    const btn = document.getElementById("btn-display");
    if (panel && !panel.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) closeDisplayPanel();
  }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function showTabBar(visible: boolean): void {
  const tabBar = document.getElementById("tab-bar");
  if (tabBar) tabBar.style.display = visible ? "" : "none";
}

function showContent(html: string): void {
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.innerHTML = html;
}

function showSummary(): void {
  switchZoomContext("gmail");
  showContent('<div class="status">Summary is coming soon...</div>');
}

function switchTab(tab: "summary" | "search", skipNavigation: boolean = false): void {
  currentTab = tab;
  syncState();
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "summary") {
    searchTab.deactivate();
    if (!skipNavigation && returnToInbox && onGmailPage) sendFiltersOff();
    showSummary();
  } else {
    switchZoomContext("gmail");
    searchTab.activate(true);
  }
}

document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
  t.addEventListener("click", () => { switchTab(t.dataset.tab as "summary" | "search"); });
});

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

function syncState(): void {
  if (activePort) activePort.postMessage({ type: "syncState", returnToInbox, onFiltersTab: currentTab === "search" });
}

function syncSettings(): void {
  if (!activePort) return;
  const s = searchTab.getInitSettings();
  activePort.postMessage({ type: "syncSettings", showStarred: s.showStarred, showImportant: s.showImportant, concurrency: s.concurrency });
}

function sendFiltersOff(): void {
  if (!activePort) return;
  activePort.postMessage({ type: "filtersOff" });
}

// ---------------------------------------------------------------------------
// Help page
// ---------------------------------------------------------------------------

function openShortcutsPage(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
}

function isShowingHelp(): boolean {
  return document.getElementById("content")?.querySelector(".help") !== null;
}

function showHelp(): void {
  switchZoomContext("help");
  showTabBar(false);
  showContent(renderHelp());
  document.querySelector<HTMLAnchorElement>(".help-shortcuts-link")?.addEventListener("click", openShortcutsPage);
}

function returnFromHelp(): void {
  if (onGmailPage) {
    showTabBar(true);
    if (currentTab === "search") searchTab.loadLabels();
    else if (currentTab === "summary") showSummary();
  }
}

document.getElementById("btn-help")?.addEventListener("click", () => {
  if (isShowingHelp()) {
    returnFromHelp();
  } else {
    showHelp();
  }
});

// ---------------------------------------------------------------------------
// Port connection to background (messages received via port.onMessage)
// ---------------------------------------------------------------------------

export function handleMessage(message: { type: string; labels?: GmailLabel[]; accountPath?: string; phase?: string; labelsTotal?: number; labelsDone?: number; currentLabel?: string; errorText?: string; labelId?: string; count?: number; coLabelCounts?: Record<string, number>; counts?: Record<string, { own: number; inclusive: number }>; complete?: boolean; seq?: number; filterConfig?: Record<string, unknown>; partial?: boolean }): void {
  if (message.type === "resultsReady") {
    const wasOffGmail = !onGmailPage;
    onGmailPage = true;
    // Detect Gmail account changes and reset state to avoid cross-account contamination
    const accountChanged = message.accountPath !== undefined && currentAccountPath !== null && message.accountPath !== currentAccountPath;
    if (message.accountPath !== undefined) currentAccountPath = message.accountPath;
    if (accountChanged) searchTab.reset();
    // Auto-dismiss help if it was shown because user was on a non-Gmail page
    if (isShowingHelp() && !wasOffGmail && !accountChanged) return;
    showTabBar(true);
    if (currentTab === "search") {
      switchZoomContext("gmail");
      searchTab.activate(true);
    } else if (currentTab === "summary") {
      showSummary();
    }
  } else if (message.type === "labelsReady") {
    // Delegate to search tab, then handle initial navigation
    searchTab.handleMessage(message);
    if (needsInitialNav || searchTab.hasActiveLabel()) {
      needsInitialNav = false;
      searchTab.sendSelection();
    }
    return;
  } else if (message.type === "userNavigated") {
    // User clicked a Gmail navigation link (Inbox, Sent, label, etc.) — switch to Summary
    // skipNavigation: the user already navigated where they want, don't override with return-to-inbox
    if (currentTab !== "summary") switchTab("summary", true);
  } else if (message.type === "notOnGmail") {
    onGmailPage = false;
    searchTab.reset();
    if (!isShowingHelp()) showHelp();
  } else {
    // Delegate remaining messages (filterResults, cacheState, labelsError, fetchError) to search tab
    searchTab.handleMessage(message);
  }
}

let activePort: chrome.runtime.Port | null = null;
/** True after (re)connect until the first labelsReady — ensures we navigate Gmail to match the current filter on panel open. */
let needsInitialNav = false;

if (chrome.runtime?.connect) {
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  const connectToBackground = (): void => {
    if (!chrome.runtime?.id) return;
    try {
      const port = chrome.runtime.connect(undefined, { name: "sidepanel" });
      activePort = port;
      searchTab.setPort(port);
      needsInitialNav = true;
      reconnectDelay = 1000;
      port.onMessage.addListener(handleMessage);
      chrome.windows.getCurrent().then((win) => {
        const s = searchTab.getInitSettings();
        port.postMessage({ type: "initWindow", windowId: win.id, scopeTimestamp: s.scopeTimestamp });
        port.postMessage({ type: "setPinMode", mode: currentPinMode });
        port.postMessage({ type: "syncSettings", showStarred: s.showStarred, showImportant: s.showImportant, concurrency: s.concurrency });
        syncState();
      });
      port.onDisconnect.addListener(() => {
        activePort = null;
        searchTab.setPort(null);
        if (!chrome.runtime?.id) return;
        setTimeout(connectToBackground, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      });
    } catch { /* Extension context invalidated */ }
  };
  connectToBackground();
}

// Show loading on startup
showContent('<div class="status">Loading...</div>');
