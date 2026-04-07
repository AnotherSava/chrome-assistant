import { renderHelp } from "./help.js";
import { escapeHtml, ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";
import { loadSetting, saveSetting } from "@core/settings.js";
import type { PinMode, GmailLabel } from "@core/types.js";
interface LabelTreeNode { name: string; fullName: string; id: string; children: LabelTreeNode[] }

let currentTab: "summary" | "filters" = "filters";
const KEY_ACTIVE_LABEL = "ca_active_label";
const KEY_ACTIVE_LABEL_NAME = "ca_active_label_name";
let activeLabelId: string | null = loadSetting(KEY_ACTIVE_LABEL, null as string | null);
let activeLabelName: string | null = loadSetting(KEY_ACTIVE_LABEL_NAME, null as string | null);
let onGmailPage = false;
let currentAccountPath: string | null = null;

// ---------------------------------------------------------------------------
// Migration: remove old localStorage cache keys (replaced by IndexedDB)
// ---------------------------------------------------------------------------

const OLD_CACHE_KEYS = ["ca_msg_cache_labels", "ca_msg_cache_messages", "ca_msg_cache_oldest", "ca_msg_cache_broad_oldest", "ca_msg_cache_complete", "ca_msg_cache_label_oldest", "ca_msg_cache_newest", "ca_msg_cache_ids", "ca_msg_cache_account"];
for (const key of OLD_CACHE_KEYS) localStorage.removeItem(key);

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export function scopeToTimestamp(scopeValue: string): number | null {
  if (scopeValue === "any") return null;
  const now = Date.now();
  const map: Record<string, () => number> = {
    "1w": () => now - 7 * 86400000,
    "2w": () => now - 14 * 86400000,
    "1m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d.getTime(); },
    "2m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 2); return d.getTime(); },
    "6m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 6); return d.getTime(); },
    "1y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d.getTime(); },
    "3y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); return d.getTime(); },
    "5y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); return d.getTime(); },
  };
  const fn = map[scopeValue];
  return fn ? fn() : null;
}

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

const KEY_LABEL_COLUMNS = "ca_label_columns";
const KEY_SCOPE_VALUE = "ca_scope_value";
const KEY_RETURN_TO_INBOX = "ca_return_to_inbox";
const KEY_INCLUDE_CHILDREN = "ca_include_children";
const KEY_SHOW_COUNTS = "ca_show_counts";
const KEY_SHOW_STARRED = "ca_show_starred";
const KEY_SHOW_IMPORTANT = "ca_show_important";
let labelColumns: number = loadSetting(KEY_LABEL_COLUMNS, 3);
let scopeValue: string = loadSetting(KEY_SCOPE_VALUE, "any");
let returnToInbox: boolean = loadSetting(KEY_RETURN_TO_INBOX, true);
let includeChildren: boolean = loadSetting(KEY_INCLUDE_CHILDREN, true);
let showCounts: boolean = loadSetting(KEY_SHOW_COUNTS, true);
let showStarred: boolean = loadSetting(KEY_SHOW_STARRED, false);
let showImportant: boolean = loadSetting(KEY_SHOW_IMPORTANT, false);

let displayPanelOpen = false;

const SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "any" },
  { value: "1w", label: "1 week ago" },
  { value: "2w", label: "2 weeks ago" },
  { value: "1m", label: "1 month ago" },
  { value: "2m", label: "2 months ago" },
  { value: "6m", label: "6 months ago" },
  { value: "1y", label: "1 year ago" },
  { value: "3y", label: "3 years ago" },
  { value: "5y", label: "5 years ago" },
];

function closeDisplayPanel(): void {
  const panel = document.getElementById("display-panel");
  if (panel) panel.style.display = "none";
  displayPanelOpen = false;
}

function buildDisplayPanel(): void {
  const panel = document.getElementById("display-panel");
  if (!panel) return;
  const colOptions = [1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === labelColumns ? " selected" : ""}>${n}</option>`).join("");
  panel.innerHTML = `<div class="display-row"><label>Columns</label><select id="col-select">${colOptions}</select></div><div class="display-row"><input type="checkbox" id="return-inbox-check"${returnToInbox ? " checked" : ""}><label for="return-inbox-check">Return to Inbox when Filters tab closes</label></div><div class="display-row"><input type="checkbox" id="include-children-check"${includeChildren ? " checked" : ""}><label for="include-children-check">Include sub-labels when selecting a parent</label></div><div class="display-row"><input type="checkbox" id="show-counts-check"${showCounts ? " checked" : ""}><label for="show-counts-check">Show email counts</label></div><div class="display-row"><input type="checkbox" id="show-starred-check"${showStarred ? " checked" : ""}><label for="show-starred-check">Show Starred</label></div><div class="display-row"><input type="checkbox" id="show-important-check"${showImportant ? " checked" : ""}><label for="show-important-check">Show Important</label></div>`;
  const colSelect = document.getElementById("col-select") as HTMLSelectElement;
  colSelect.addEventListener("change", () => {
    labelColumns = parseInt(colSelect.value, 10);
    saveSetting(KEY_LABEL_COLUMNS, labelColumns);
    if (currentTab === "filters") loadLabels();
  });
  const returnCheck = document.getElementById("return-inbox-check") as HTMLInputElement;
  returnCheck.addEventListener("change", () => {
    returnToInbox = returnCheck.checked;
    saveSetting(KEY_RETURN_TO_INBOX, returnToInbox);
    syncState();
  });
  const childrenCheck = document.getElementById("include-children-check") as HTMLInputElement;
  childrenCheck.addEventListener("change", () => {
    includeChildren = childrenCheck.checked;
    saveSetting(KEY_INCLUDE_CHILDREN, includeChildren);
    if (activeLabelId) {
      sendSelectionChanged();
    } else {
      refreshLabelsIfVisible();
    }
  });
  const countsCheck = document.getElementById("show-counts-check") as HTMLInputElement;
  countsCheck.addEventListener("change", () => {
    showCounts = countsCheck.checked;
    saveSetting(KEY_SHOW_COUNTS, showCounts);
    if (showCounts) {
      loadLabels(true);
    } else {
      labelCounts = null;
      refreshLabelsIfVisible();
    }
  });
  const starredCheck = document.getElementById("show-starred-check") as HTMLInputElement;
  starredCheck.addEventListener("change", () => {
    setShowStarred(starredCheck.checked);
    saveSetting(KEY_SHOW_STARRED, showStarred);
    if (!showStarred && activeLabelId === "STARRED") selectLabel(null);
    refreshLabelsIfVisible();
    if (activePort) activePort.postMessage({ type: "syncSettings", showStarred, showImportant });
  });
  const importantCheck = document.getElementById("show-important-check") as HTMLInputElement;
  importantCheck.addEventListener("change", () => {
    setShowImportant(importantCheck.checked);
    saveSetting(KEY_SHOW_IMPORTANT, showImportant);
    if (!showImportant && activeLabelId === "IMPORTANT") selectLabel(null);
    refreshLabelsIfVisible();
    if (activePort) activePort.postMessage({ type: "syncSettings", showStarred, showImportant });
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

function showSummary(): void {
  switchZoomContext("gmail");
  showContent('<div class="status">Summary is coming soon...</div>');
}

function switchTab(tab: "summary" | "filters", skipNavigation: boolean = false): void {
  currentTab = tab;
  syncState();
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "summary") {
    if (!skipNavigation && returnToInbox && onGmailPage) sendFiltersOff();
    showSummary();
  } else {
    if (onGmailPage && cachedLabels) {
      sendSelectionChanged();
      renderFilteredLabels();
    }
    loadLabels(true);
  }
}

document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
  t.addEventListener("click", () => { switchTab(t.dataset.tab as "summary" | "filters"); });
});

// ---------------------------------------------------------------------------
// Render emails
// ---------------------------------------------------------------------------

function showContent(html: string): void {
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Labels / Tags
// ---------------------------------------------------------------------------

const LABELS_HIDDEN = new Set(["CHAT", "DRAFT", "SPAM", "TRASH", "UNREAD", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "YELLOW_STAR", "ORANGE_STAR", "RED_STAR", "PURPLE_STAR", "BLUE_STAR", "GREEN_STAR", "RED_BANG", "ORANGE_GUILLEMET", "YELLOW_BANG", "GREEN_CHECK", "BLUE_INFO", "PURPLE_QUESTION"]);

/** System labels shown in fixed order before user labels */
const SYSTEM_LABEL_ORDER = ["INBOX", "SENT", "STARRED", "IMPORTANT"];

// Apply initial hidden state for conditional system labels
if (!showStarred) LABELS_HIDDEN.add("STARRED");
if (!showImportant) LABELS_HIDDEN.add("IMPORTANT");

function buildLabelTree(labels: GmailLabel[]): LabelTreeNode[] {
  const visible = labels.filter((l) => !LABELS_HIDDEN.has(l.id) && !LABELS_HIDDEN.has(l.name));
  visible.sort((a, b) => {
    const aSystem = SYSTEM_LABEL_ORDER.indexOf(a.id);
    const bSystem = SYSTEM_LABEL_ORDER.indexOf(b.id);
    // Both are system labels in our fixed order — sort by that order
    if (aSystem !== -1 && bSystem !== -1) return aSystem - bSystem;
    // System labels in fixed order come first
    if (aSystem !== -1) return -1;
    if (bSystem !== -1) return 1;
    // Other system labels before user labels
    if (a.type !== b.type) return a.type === "system" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Build a set of all label names to check if a parent segment is a real label
  const labelNames = new Set(visible.map((l) => l.name));

  const root: LabelTreeNode[] = [];
  const nodeMap = new Map<string, LabelTreeNode>();

  for (const label of visible) {
    const parts = label.name.split("/");
    // Only treat as nested if every ancestor prefix is also a real label
    let isNested = parts.length > 1;
    if (isNested) {
      for (let i = 1; i < parts.length; i++) {
        if (!labelNames.has(parts.slice(0, i).join("/"))) { isNested = false; break; }
      }
    }

    if (!isNested) {
      // Flat label — use the full name as display
      const node: LabelTreeNode = { name: label.name, fullName: label.name, id: label.id, children: [] };
      nodeMap.set(label.name, node);
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parentNode = nodeMap.get(parentPath);
      if (!parentNode) {
        // Treat as root-level if parent is missing (e.g., hidden parent)
        const node: LabelTreeNode = { name: label.name, fullName: label.name, id: label.id, children: [] };
        nodeMap.set(label.name, node);
        root.push(node);
        continue;
      }
      const node: LabelTreeNode = { name: parts[parts.length - 1], fullName: label.name, id: label.id, children: [] };
      nodeMap.set(label.name, node);
      parentNode.children.push(node);
    }
  }

  return root;
}

export function setIncludeChildren(value: boolean): void {
  includeChildren = value;
}

export function setShowCounts(value: boolean): void {
  showCounts = value;
}

export function setShowStarred(value: boolean): void {
  showStarred = value;
  if (showStarred) LABELS_HIDDEN.delete("STARRED"); else LABELS_HIDDEN.add("STARRED");
}

export function setShowImportant(value: boolean): void {
  showImportant = value;
  if (showImportant) LABELS_HIDDEN.delete("IMPORTANT"); else LABELS_HIDDEN.add("IMPORTANT");
}


function countNodes(node: LabelTreeNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function splitIntoColumns(nodes: LabelTreeNode[], numColumns: number): LabelTreeNode[][] {
  const sizes = nodes.map((n) => countNodes(n));
  const total = sizes.reduce((a, b) => a + b, 0);
  const target = total / numColumns;
  const columns: LabelTreeNode[][] = [];
  let current: LabelTreeNode[] = [];
  let currentCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    // Decide whether adding this node to the current column or starting a new one produces better balance
    if (current.length > 0 && columns.length < numColumns - 1) {
      const overflowIfAdded = Math.abs(currentCount + sizes[i] - target);
      const underflowIfSplit = Math.abs(currentCount - target);
      if (underflowIfSplit <= overflowIfAdded) {
        columns.push(current);
        current = [];
        currentCount = 0;
      }
    }
    current.push(nodes[i]);
    currentCount += sizes[i];
  }
  if (current.length > 0) columns.push(current);
  return columns;
}

function getLabelCount(labelId: string): number | null {
  if (!showCounts) return null;
  if (activeLabelId && lastLabelResult) {
    // When a label is selected, show co-label counts from the query result
    if (labelId === activeLabelId) return lastLabelResult.count;
    const count = lastLabelResult.coLabelCounts[labelId];
    return count !== undefined ? count : null;
  }
  // No label selected — use global label counts
  if (!labelCounts) return null;
  const entry = labelCounts[labelId];
  if (!entry) return null;
  return includeChildren ? entry.inclusive : entry.own;
}

/** Update count spans in-place without re-rendering the label tree. */
function updateCountsInPlace(): void {
  document.querySelectorAll<HTMLAnchorElement>(".label-link").forEach((link) => {
    const labelId = link.dataset.labelId;
    if (!labelId) return;
    const count = getLabelCount(labelId);
    let span = link.querySelector(".label-count") as HTMLSpanElement | null;
    if (count !== null) {
      if (span) {
        span.textContent = ` (${count})`;
      } else {
        span = document.createElement("span");
        span.className = "label-count";
        span.textContent = ` (${count})`;
        link.appendChild(span);
      }
    } else if (span) {
      span.remove();
    }
  });
}

/** Whether a fetchCounts request is in flight */
let countsInFlight = false;
/** Whether more progress arrived while a fetchCounts was in flight */
let countsPending = false;

/** Request just label counts from background (no Gmail API call). */
function requestCounts(): void {
  if (!activePort || !showCounts) return;
  if (countsInFlight) { countsPending = true; return; }
  countsInFlight = true;
  countsPending = false;
  fetchCountsSeq++;
  activePort.postMessage({ type: "fetchCounts", scopeTimestamp: scopeToTimestamp(scopeValue), seq: fetchCountsSeq });
}

function renderLabelTree(nodes: LabelTreeNode[]): string {
  if (nodes.length === 0) return "";
  const items = nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const activeClass = node.id === activeLabelId ? " active" : "";
    const count = getLabelCount(node.id);
    const countSpan = count !== null ? `<span class="label-count"> (${count})</span>` : "";
    const link = `<a class="label-link${activeClass}" href="#" data-label-id="${escapeHtml(node.id)}" data-label-name="${escapeHtml(node.fullName)}">${escapeHtml(node.name)}${countSpan}</a>`;
    const children = hasChildren ? `<ul class="label-tree">${renderLabelTree(node.children)}</ul>` : "";
    return `<li class="label-node">${link}${children}</li>`;
  }).join("");
  return items;
}

/** Change the selected label. Pass null to deselect. */
function selectLabel(labelId: string | null): void {
  activeLabelId = labelId;
  activeLabelName = labelId ? (cachedLabels?.find(l => l.id === labelId)?.name ?? null) : null;
  saveSetting(KEY_ACTIVE_LABEL, activeLabelId);
  saveSetting(KEY_ACTIVE_LABEL_NAME, activeLabelName);
  lastLabelResult = null;

  document.querySelectorAll<HTMLElement>(".label-link").forEach((l) => l.classList.remove("active"));
  if (labelId) {
    document.querySelector<HTMLElement>(`.label-link[data-label-id="${labelId}"]`)?.classList.add("active");
  } else {
    renderFilteredLabels();
  }
  sendSelectionChanged();
}

function setupLabelHandlers(): void {
  document.querySelectorAll<HTMLAnchorElement>(".label-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const labelId = link.dataset.labelId;
      if (!labelId) return;
      selectLabel(activeLabelId === labelId ? null : labelId);
    });
  });
}

function scopeToDate(): string | null {
  const ts = scopeToTimestamp(scopeValue);
  if (ts === null) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function syncState(): void {
  if (activePort) activePort.postMessage({ type: "syncState", returnToInbox, onFiltersTab: currentTab === "filters" });
}

function sendFiltersOff(): void {
  if (!activePort) return;
  activePort.postMessage({ type: "filtersOff" });
}

function renderFilterBar(): string {
  const scopeOptions = SCOPE_OPTIONS.map((o) => `<option value="${o.value}"${o.value === scopeValue ? " selected" : ""}>${o.label}</option>`).join("");
  return `<div class="filter-bar"><span class="filter-item"><label>Scope from:</label><select id="scope-select">${scopeOptions}</select></span><span class="filter-break"></span><div id="cache-progress" class="cache-progress"></div></div>`;
}

function setupFilterBar(): void {
  const scopeSelect = document.getElementById("scope-select") as HTMLSelectElement | null;
  scopeSelect?.addEventListener("change", () => {
    scopeValue = scopeSelect.value;
    saveSetting(KEY_SCOPE_VALUE, scopeValue);
    sendSelectionChanged();
    if (showCounts) requestCounts();
  });
}

let cachedLabels: GmailLabel[] | null = null;
let labelCounts: Record<string, { own: number; inclusive: number }> | null = null;

function renderLabels(labels: GmailLabel[]): void {
  switchZoomContext("gmail");
  try {
    const tree = buildLabelTree(labels);
    const columns = splitIntoColumns(tree, labelColumns);
    const columnsHtml = columns.map((col) => `<ul class="label-tree label-column">${renderLabelTree(col)}</ul>`).join("");
    showContent(`${renderFilterBar()}<div class="label-columns">${columnsHtml}</div>`);
    setupFilterBar();
    setupLabelHandlers();
    updateCacheProgress();
  } catch (err) {
    showContent(`<div class="status">Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`);
  }
}

// ---------------------------------------------------------------------------
// Cache-based label filtering (replaces old broad/targeted fetch system)
// ---------------------------------------------------------------------------

/** Last cache progress pushed from background */
let lastCacheProgress: { phase: string; labelsTotal: number; labelsDone: number; datesTotal: number; datesDone: number; currentLabel?: string } | null = null;

/** Last label query result from background */
let lastLabelResult: { labelId: string; count: number; coLabelCounts: Record<string, number> } | null = null;

/** Whether the last queryLabel request failed */
let lastQueryError = false;

/** Monotonic sequence number to correlate queryLabel requests with responses */
let queryLabelSeq = 0;

/** Monotonic sequence number to correlate fetchLabels requests with labelsReady responses */
let fetchLabelsSeq = 0;

/** Separate sequence number for fetchCounts requests */
let fetchCountsSeq = 0;

/** Send a selectionChanged message to background for the current selection state */
function sendSelectionChanged(): void {
  if (!activePort) return;
  lastQueryError = false;
  queryLabelSeq++;
  updateCacheProgress();
  activePort.postMessage({ type: "selectionChanged", labelId: activeLabelId, includeChildren, scope: scopeToDate(), scopeTimestamp: scopeToTimestamp(scopeValue), seq: queryLabelSeq });
}

/** Add parent label IDs to a set based on label name hierarchy */
function addParentChain(ids: Set<string>, labels: GmailLabel[]): Set<string> {
  const result = new Set(ids);
  const nameToId = new Map<string, string>();
  for (const l of labels) nameToId.set(l.name, l.id);
  for (const id of ids) {
    const label = labels.find(l => l.id === id);
    if (!label) continue;
    const parts = label.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parentName = parts.slice(0, i).join("/");
      const parentId = nameToId.get(parentName);
      if (parentId) result.add(parentId);
    }
  }
  return result;
}

function renderFilteredLabels(): void {
  if (!cachedLabels) return;

  if (!activeLabelId || !lastLabelResult) {
    // No label selected or no query result yet — show all labels
    renderLabels(cachedLabels);
    return;
  }

  // Use the cache query result to filter visible labels
  const coLabelIds = new Set(Object.keys(lastLabelResult.coLabelCounts));

  // Always show the active label and its parent chain
  coLabelIds.add(activeLabelId);
  const activeLabel = cachedLabels.find(l => l.id === activeLabelId);
  if (activeLabel) {
    const parts = activeLabel.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parentName = parts.slice(0, i).join("/");
      const parent = cachedLabels.find(l => l.name === parentName);
      if (parent) coLabelIds.add(parent.id);
    }
  }

  // Add parent chain for co-labels too
  const withParents = addParentChain(coLabelIds, cachedLabels);

  const filteredLabels = cachedLabels.filter(l => withParents.has(l.id));
  renderLabels(filteredLabels.length > 0 ? filteredLabels : cachedLabels);
}

function cacheStatusIcon(done: boolean): string {
  return done ? '<span class="cache-done">&#x2714;</span>' : '<span class="cache-spin">&#x25E0;</span>';
}

function formatCacheStatus(label: string, done: boolean, detail: string | null, count: number | null): string {
  if (done) return `${label}: ${count ?? 0} emails ${cacheStatusIcon(true)}`;
  const info = detail ?? "starting...";
  return `${label}: ${info} ${cacheStatusIcon(false)}`;
}

function updateCacheProgress(): void {
  const el = document.getElementById("cache-progress");
  if (!el) return;
  const parts: string[] = [];

  if (lastQueryError && activeLabelId) {
    parts.push("query failed — showing unfiltered labels");
  } else if (lastLabelResult && activeLabelId) {
    parts.push(formatCacheStatus("current", true, null, lastLabelResult.count));
  }

  if (lastCacheProgress) {
    if (lastCacheProgress.phase === "labels") {
      const labelName = lastCacheProgress.currentLabel ? ` — ${lastCacheProgress.currentLabel}` : "";
      parts.push(`Background caching: labels ${lastCacheProgress.labelsDone}/${lastCacheProgress.labelsTotal}${labelName} ${cacheStatusIcon(false)}`);
    } else if (lastCacheProgress.phase === "dates") {
      parts.push(`Background caching: dates ${lastCacheProgress.datesDone}/${lastCacheProgress.datesTotal} ${cacheStatusIcon(false)}`);
    }
  }

  el.innerHTML = parts.join(" | ");
}

function refreshLabelsIfVisible(): void {
  if (currentTab === "filters" && onGmailPage && cachedLabels) renderFilteredLabels();
}

function loadLabels(forceRefresh: boolean = false): void {
  if (cachedLabels && !forceRefresh) {
    renderFilteredLabels();
    return;
  }
  if (!cachedLabels) showContent('<div class="status">Loading labels...</div>');
  if (activePort) {
    fetchLabelsSeq++;
    activePort.postMessage({ type: "fetchLabels", seq: fetchLabelsSeq });
  }
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
    if (currentTab === "filters") loadLabels();
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

export function handleMessage(message: { type: string; labels?: GmailLabel[]; accountPath?: string; phase?: string; labelsTotal?: number; labelsDone?: number; datesTotal?: number; datesDone?: number; currentLabel?: string; labelId?: string; count?: number; coLabelCounts?: Record<string, number>; counts?: Record<string, { own: number; inclusive: number }>; complete?: boolean; seq?: number; error?: boolean }): void {
  if (message.type === "resultsReady") {
    const wasOffGmail = !onGmailPage;
    onGmailPage = true;
    // Detect Gmail account changes and reset state to avoid cross-account contamination
    const accountChanged = message.accountPath !== undefined && currentAccountPath !== null && message.accountPath !== currentAccountPath;
    if (message.accountPath !== undefined) currentAccountPath = message.accountPath;
    if (accountChanged) {
      // Clear stale label UI state from the previous account
      cachedLabels = null;
      labelCounts = null;
      activeLabelId = null;
      activeLabelName = null;
      lastLabelResult = null;
      lastCacheProgress = null;
      saveSetting(KEY_ACTIVE_LABEL, null);
      saveSetting(KEY_ACTIVE_LABEL_NAME, null);
    }
    // Auto-dismiss help if it was shown because user was on a non-Gmail page
    if (isShowingHelp() && !wasOffGmail && !accountChanged) return;
    showTabBar(true);
    if (currentTab === "filters") {
      loadLabels(true);
    } else if (currentTab === "summary") {
      showSummary();
    }
  } else if (message.type === "labelsReady" && message.labels) {
    // Ignore stale responses from earlier fetchLabels requests (avoids race on account switches)
    if (message.seq !== undefined && message.seq !== fetchLabelsSeq) return;
    cachedLabels = message.labels;
    if (message.counts) labelCounts = message.counts;
    else if (!showCounts) labelCounts = null;
    // Validate and refresh saved label against the current account's labels
    if (activeLabelId !== null) {
      const matchedLabel = cachedLabels.find((l) => l.id === activeLabelId);
      if (!matchedLabel || LABELS_HIDDEN.has(activeLabelId)) {
        activeLabelId = null;
        activeLabelName = null;
        saveSetting(KEY_ACTIVE_LABEL, null);
        saveSetting(KEY_ACTIVE_LABEL_NAME, null);
      } else if (matchedLabel.name !== activeLabelName) {
        activeLabelName = matchedLabel.name;
        saveSetting(KEY_ACTIVE_LABEL_NAME, activeLabelName);
      }
    }
    refreshLabelsIfVisible();
    // If a label is selected, send selection to background for query + navigation
    if (activeLabelId) sendSelectionChanged();
    // Request counts separately (non-blocking)
    if (showCounts) requestCounts();
  } else if (message.type === "labelsError") {
    if (currentTab === "filters" && onGmailPage && !cachedLabels) {
      showContent('<div class="status">Loading labels...</div>');
      setTimeout(() => { if (!cachedLabels && onGmailPage) loadLabels(true); }, 3000);
    }
  } else if (message.type === "countsReady" && message.counts) {
    if (message.seq !== undefined && message.seq !== fetchCountsSeq) return;
    countsInFlight = false;
    labelCounts = message.counts;
    updateCountsInPlace();
    if (countsPending) requestCounts();
  } else if (message.type === "userNavigated") {
    // User clicked a Gmail navigation link (Inbox, Sent, label, etc.) — switch to Summary
    // skipNavigation: the user already navigated where they want, don't override with return-to-inbox
    if (currentTab !== "summary") switchTab("summary", true);
  } else if (message.type === "notOnGmail") {
    onGmailPage = false;
    cachedLabels = null;
    if (!isShowingHelp()) showHelp();
  } else if (message.type === "cacheState") {
    // Cache progress pushed from background
    lastCacheProgress = { phase: message.phase ?? "labels", labelsTotal: message.labelsTotal ?? 0, labelsDone: message.labelsDone ?? 0, datesTotal: message.datesTotal ?? 0, datesDone: message.datesDone ?? 0, currentLabel: message.currentLabel };
    updateCacheProgress();
    // Refresh counts during cache build (completion re-query is handled by service worker)
    if (message.phase === "labels" && showCounts) {
      requestCounts();
    }
  } else if (message.type === "labelResult" && message.labelId !== undefined) {
    // Query result from background cache — ignore stale responses
    if (message.labelId === activeLabelId && (message.seq === undefined || message.seq === queryLabelSeq)) {
      if (message.error) {
        // Query failed — clear stale result so labels show unfiltered, don't hide everything
        lastLabelResult = null;
        lastQueryError = true;
        refreshLabelsIfVisible();
        updateCacheProgress();
      } else {
        lastLabelResult = { labelId: message.labelId, count: message.count ?? 0, coLabelCounts: message.coLabelCounts ?? {} };
        lastQueryError = false;
        refreshLabelsIfVisible();
        updateCacheProgress();
      }
    }
  } else if (message.type === "fetchError") {
    showContent('<div class="status">Failed to fetch emails. Try refreshing the page.</div>');
  }
}

let activePort: chrome.runtime.Port | null = null;

if (chrome.runtime?.connect) {
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  const connectToBackground = (): void => {
    if (!chrome.runtime?.id) return;
    try {
      const port = chrome.runtime.connect(undefined, { name: "sidepanel" });
      activePort = port;
      reconnectDelay = 1000;
      port.onMessage.addListener(handleMessage);
      chrome.windows.getCurrent().then((win) => { port.postMessage({ type: "initWindow", windowId: win.id }); port.postMessage({ type: "setPinMode", mode: currentPinMode }); port.postMessage({ type: "syncSettings", showStarred, showImportant }); syncState(); });
      port.onDisconnect.addListener(() => {
        activePort = null;
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
