import { renderHelp } from "./help.js";
import { escapeHtml, ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";
import { loadSetting, saveSetting } from "@core/settings.js";
import type { PinMode, GmailLabel } from "@core/types.js";
import { getMsgCache, loadMsgCache, saveMsgCache, mergeMessages, filterMessages, deriveRelevantLabelIds, addParentChain, isCacheCovering, scopeToTimestamp, clearLabelOldest, resetMsgCache } from "./msg-cache.js";
import { buildSearchQuery } from "./gmail-api.js";
import type { MessageMeta } from "@core/types.js";
(window as any).__cache = getMsgCache;
(window as any).__filter = filterMessages;
interface LabelTreeNode { name: string; fullName: string; id: string; children: LabelTreeNode[] }

let currentTab: "summary" | "filters" = "filters";
const KEY_ACTIVE_LABEL = "ca_active_label";
const KEY_ACTIVE_LABEL_NAME = "ca_active_label_name";
let activeLabelId: string | null = loadSetting(KEY_ACTIVE_LABEL, null as string | null);
let activeLabelName: string | null = loadSetting(KEY_ACTIVE_LABEL_NAME, null as string | null);
let onGmailPage = false;
let pendingFilterApply = false;
let currentAccountPath: string | null = null;

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
const KEY_LOCATION = "ca_location";
const KEY_RETURN_TO_INBOX = "ca_return_to_inbox";
let labelColumns: number = loadSetting(KEY_LABEL_COLUMNS, 3);
let scopeValue: string = loadSetting(KEY_SCOPE_VALUE, "any");
let locationValue: string = loadSetting(KEY_LOCATION, "inbox");
let returnToInbox: boolean = loadSetting(KEY_RETURN_TO_INBOX, true);

const LOCATION_OPTIONS: { value: string; label: string }[] = [
  { value: "inbox", label: "Inbox" },
  { value: "sent", label: "Sent" },
  { value: "all", label: "All" },
];

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
  panel.innerHTML = `<div class="display-row"><label>Columns</label><select id="col-select">${colOptions}</select></div><div class="display-row"><input type="checkbox" id="return-inbox-check"${returnToInbox ? " checked" : ""}><label for="return-inbox-check">Return to Inbox when Filters tab closes</label></div>`;
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

function switchTab(tab: "summary" | "filters"): void {
  currentTab = tab;
  syncState();
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "summary") {
    if (returnToInbox && onGmailPage) resetGmailToInbox();
    showSummary();
  } else {
    if (onGmailPage) {
      pendingFilterApply = true;
      if (cachedLabels) {
        pendingFilterApply = false;
        applyFilters();
        renderLabels(cachedLabels);
      }
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

const LABELS_HIDDEN = new Set(["INBOX", "SENT", "STARRED", "CHAT", "DRAFT", "SPAM", "TRASH", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "YELLOW_STAR", "ORANGE_STAR", "RED_STAR", "PURPLE_STAR", "BLUE_STAR", "GREEN_STAR", "RED_BANG", "ORANGE_GUILLEMET", "YELLOW_BANG", "GREEN_CHECK", "BLUE_INFO", "PURPLE_QUESTION"]);

function buildLabelTree(labels: GmailLabel[]): LabelTreeNode[] {
  const visible = labels.filter((l) => !LABELS_HIDDEN.has(l.id) && !LABELS_HIDDEN.has(l.name));
  visible.sort((a, b) => {
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

function renderLabelTree(nodes: LabelTreeNode[]): string {
  if (nodes.length === 0) return "";
  const items = nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const activeClass = node.id === activeLabelId ? " active" : "";
    const link = `<a class="label-link${activeClass}" href="#" data-label-id="${escapeHtml(node.id)}" data-label-name="${escapeHtml(node.fullName)}">${escapeHtml(node.name)}</a>`;
    const children = hasChildren ? `<ul class="label-tree">${renderLabelTree(node.children)}</ul>` : "";
    return `<li class="label-node">${link}${children}</li>`;
  }).join("");
  return items;
}

function setupLabelHandlers(): void {
  document.querySelectorAll<HTMLAnchorElement>(".label-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const labelId = link.dataset.labelId;
      if (!labelId) return;
      document.querySelectorAll<HTMLElement>(".label-link").forEach((l) => l.classList.remove("active"));
      clearTargetedState();
      if (activeLabelId === labelId) {
        activeLabelId = null;
        activeLabelName = null;
        saveSetting(KEY_ACTIVE_LABEL, null);
        saveSetting(KEY_ACTIVE_LABEL_NAME, null);
        renderFilteredLabels();
        applyFilters();
      } else {
        activeLabelId = labelId;
        activeLabelName = link.dataset.labelName ?? null;
        saveSetting(KEY_ACTIVE_LABEL, labelId);
        saveSetting(KEY_ACTIVE_LABEL_NAME, activeLabelName);
        link.classList.add("active");
        renderFilteredLabels();
        applyFilters();
      }
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

function resetGmailToInbox(): void {
  if (!activePort) return;
  activePort.postMessage({ type: "applyFilters", location: "inbox", labelName: null, scope: null });
}

function applyFilters(): void {
  if (!activePort) return;
  activePort.postMessage({ type: "applyFilters", location: locationValue, labelName: activeLabelName, scope: scopeToDate() });
}

function renderFilterBar(): string {
  const locOptions = LOCATION_OPTIONS.map((o) => `<option value="${o.value}"${o.value === locationValue ? " selected" : ""}>${o.label}</option>`).join("");
  const scopeOptions = SCOPE_OPTIONS.map((o) => `<option value="${o.value}"${o.value === scopeValue ? " selected" : ""}>${o.label}</option>`).join("");
  return `<div class="filter-bar"><span class="filter-item"><label>Location:</label><select id="location-select">${locOptions}</select></span><span class="filter-break"></span><span class="filter-item"><label>Scope from:</label><select id="scope-select">${scopeOptions}</select></span><span class="filter-break"></span><div id="cache-progress" class="cache-progress"></div></div>`;
}

function setupFilterBar(): void {
  const locSelect = document.getElementById("location-select") as HTMLSelectElement | null;
  locSelect?.addEventListener("change", () => {
    locationValue = locSelect.value;
    saveSetting(KEY_LOCATION, locationValue);
    clearTargetedState();
    clearLabelOldest();
    saveMsgCache();
    renderFilteredLabels();
    applyFilters();
  });
  const scopeSelect = document.getElementById("scope-select") as HTMLSelectElement | null;
  scopeSelect?.addEventListener("change", () => {
    scopeValue = scopeSelect.value;
    saveSetting(KEY_SCOPE_VALUE, scopeValue);
    clearTargetedState();
    renderFilteredLabels();
    applyFilters();
  });
}

let cachedLabels: GmailLabel[] | null = null;

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
// Dynamic label filtering via message cache
// ---------------------------------------------------------------------------

let dimmedMode = false;
let relevantLabelIds: Set<string> = new Set();

// Targeted fetch state
let targetedFetchId: string | null = null;
let targetedInProgress = false;

// Broad cache build state
let broadFetchId: string | null = null;
let broadQuery: string = "";
let broadPaused = false;
let broadPendingToken: string | null = null;

// Targeted fetch query (stored so continuation pages can re-send it)
let targetedQuery: string = "";
let targetedOldest: number | null = null;
let targetedDoneCount: number | null = null;

function renderFilteredLabels(): void {
  if (!cachedLabels) return;
  const scopeTs = scopeToTimestamp(scopeValue);

  if (dimmedMode) {
    // During targeted fetch: render all labels, dim non-relevant ones
    renderLabels(cachedLabels);
    document.querySelectorAll<HTMLElement>(".label-link").forEach((link) => {
      const labelId = link.dataset.labelId;
      if (!labelId) return;
      if (relevantLabelIds.has(labelId) || labelId === activeLabelId) {
        link.classList.remove("dimmed");
      } else {
        link.classList.add("dimmed");
      }
    });
    return;
  }

  const covering = isCacheCovering(activeLabelId, scopeTs);
  if (!covering && activeLabelId === null) {
    // Not covered, no label selected: show all labels
    targetedDoneCount = null;
    renderLabels(cachedLabels);
    return;
  }
  if (!covering && activeLabelId !== null && activeLabelName !== null) {
    // Not covered, label selected: trigger targeted fetch
    if (!targetedInProgress) {
      startTargetedFetch(activeLabelId, activeLabelName);
    }
    // If targeted fetch couldn't start (e.g. no activePort during reconnect), render all labels as fallback
    if (!targetedInProgress) {
      renderLabels(cachedLabels);
    }
    return;
  }

  // Cache covers the query — filter locally
  const filtered = filterMessages(locationValue, scopeTs, activeLabelId);
  targetedDoneCount = activeLabelId !== null ? filtered.length : null;
  let ids = deriveRelevantLabelIds(filtered);
  ids = addParentChain(ids, cachedLabels);

  // Selected label + parent chain always visible
  if (activeLabelId) {
    ids.add(activeLabelId);
    const activeLabel = cachedLabels.find((l) => l.id === activeLabelId);
    if (activeLabel) {
      const parts = activeLabel.name.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parentName = parts.slice(0, i).join("/");
        const parent = cachedLabels.find((l) => l.name === parentName);
        if (parent) ids.add(parent.id);
      }
    }
  }

  const filteredLabels = cachedLabels.filter((l) => ids.has(l.id));
  renderLabels(filteredLabels.length > 0 ? filteredLabels : cachedLabels);
}

function formatProgressDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function cacheStatusIcon(done: boolean): string {
  return done ? '<span class="cache-done">&#x2714;</span>' : '<span class="cache-spin">&#x25E0;</span>';
}

function formatCacheStatus(label: string, done: boolean, date: number | null, count: number | null): string {
  if (done) return `${label}: ${count ?? 0} emails ${cacheStatusIcon(true)}`;
  const datePart = date !== null ? formatProgressDate(date) : null;
  const countPart = count !== null ? `(${count})` : null;
  const detail = datePart && countPart ? `${datePart} ${countPart}` : datePart ?? countPart ?? "starting...";
  return `${label}: ${detail} ${cacheStatusIcon(false)}`;
}

function updateCacheProgress(): void {
  const el = document.getElementById("cache-progress");
  if (!el) return;
  const cache = getMsgCache();
  const parts: string[] = [];
  if (cache.oldest !== null || cache.complete) {
    const count = cache.messages.length > 0 ? cache.messages.length : null;
    parts.push(formatCacheStatus("global", cache.complete, cache.complete ? null : cache.oldest, count));
  } else if (broadFetchId) {
    parts.push(formatCacheStatus("global", false, null, null));
  }
  if (targetedInProgress) {
    parts.push(formatCacheStatus("current", false, targetedOldest, targetedDoneCount));
  } else if (targetedDoneCount !== null) {
    parts.push(formatCacheStatus("current", true, null, targetedDoneCount));
  }
  el.innerHTML = parts.length > 0 ? `Caching: ${parts.join(" | ")}` : "";
}

function generateFetchId(prefix: string = "broad"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function refreshLabelsIfVisible(): void {
  if (currentTab === "filters" && onGmailPage && cachedLabels) renderFilteredLabels();
}

function clearTargetedState(): void {
  if (targetedInProgress) {
    targetedFetchId = null;
    targetedInProgress = false;
    targetedOldest = null;
    dimmedMode = false;
    relevantLabelIds = new Set();
    // Resume broad build if it was paused by this targeted fetch
    broadPaused = false;
    if (broadFetchId && broadPendingToken) {
      const token = broadPendingToken;
      broadPendingToken = null;
      continueBroadBuild(token);
    }
  }
}

function startTargetedFetch(labelId: string, labelName: string): void {
  if (!activePort) return;

  // Pause broad build
  broadPaused = true;

  // Build gap query: fetch messages with this label, before the broad build's oldest
  const cache = getMsgCache();
  let beforeDate: string | null = null;
  if (cache.broadOldest !== null) {
    const d = new Date(cache.broadOldest);
    d.setDate(d.getDate() + 1); // +1 day for overlap (Gmail before: is exclusive, day granularity); dedup handles duplicates
    beforeDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  targetedQuery = buildSearchQuery(locationValue, labelName, scopeToDate(), beforeDate);
  targetedFetchId = generateFetchId("targeted");
  targetedInProgress = true;
  targetedOldest = null;
  targetedDoneCount = filterMessages(locationValue, scopeToTimestamp(scopeValue), labelId).length;
  dimmedMode = true;

  // Compute initial relevantLabelIds from whatever the cache already has
  const scopeTs = scopeToTimestamp(scopeValue);
  const filtered = filterMessages(locationValue, scopeTs, labelId);
  relevantLabelIds = deriveRelevantLabelIds(filtered);
  if (cachedLabels) relevantLabelIds = addParentChain(relevantLabelIds, cachedLabels);
  relevantLabelIds.add(labelId);

  // Render dimmed labels
  renderFilteredLabels();

  // Send first page request
  activePort.postMessage({ type: "fetchMessagePage", query: targetedQuery, fetchId: targetedFetchId });
}

function startBroadBuild(): void {
  if (!activePort) return;
  if (targetedInProgress) return;
  if (broadFetchId) return;
  const cache = getMsgCache();
  broadFetchId = generateFetchId();
  broadPaused = false;
  broadPendingToken = null;

  // Incremental refresh: if we have cached messages, only fetch newer ones.
  // Subtract one day because Gmail's after: operator has day granularity and is exclusive.
  if (cache.newest !== null && cache.messages.length > 0) {
    const d = new Date(cache.newest);
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    broadQuery = `after:${dateStr}`;
  } else {
    broadQuery = "";
  }

  activePort.postMessage({ type: "fetchMessagePage", query: broadQuery, fetchId: broadFetchId });
}

function continueBroadBuild(nextPageToken: string): void {
  if (!activePort || !broadFetchId) return;
  if (broadPaused) {
    broadPendingToken = nextPageToken;
    return;
  }
  activePort.postMessage({ type: "fetchMessagePage", query: broadQuery, pageToken: nextPageToken, fetchId: broadFetchId });
}

function loadLabels(forceRefresh: boolean = false): void {
  if (cachedLabels && !forceRefresh) {
    renderFilteredLabels();
    return;
  }
  if (!cachedLabels) showContent('<div class="status">Loading labels...</div>');
  if (activePort) {
    activePort.postMessage({ type: "fetchLabels" });
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

function handleMessage(message: { type: string; labels?: GmailLabel[]; messages?: MessageMeta[]; nextPageToken?: string | null; totalEstimate?: number; fetchId?: string; accountPath?: string }): void {
  if (message.type === "resultsReady") {
    const wasOffGmail = !onGmailPage;
    onGmailPage = true;
    if (wasOffGmail) pendingFilterApply = true;
    // Detect Gmail account changes and reset cache to avoid cross-account contamination
    const accountChanged = message.accountPath !== undefined && currentAccountPath !== null && message.accountPath !== currentAccountPath;
    if (message.accountPath !== undefined) currentAccountPath = message.accountPath;
    if (accountChanged) {
      resetMsgCache();
      saveMsgCache(currentAccountPath ?? undefined);
      broadFetchId = null;
      broadPaused = false;
      broadPendingToken = null;
      clearTargetedState();
      // Clear stale label UI state from the previous account
      cachedLabels = null;
      activeLabelId = null;
      activeLabelName = null;
      saveSetting(KEY_ACTIVE_LABEL, null);
      saveSetting(KEY_ACTIVE_LABEL_NAME, null);
      pendingFilterApply = true;
    }
    // Auto-dismiss help if it was shown because user was on a non-Gmail page
    if (isShowingHelp() && !wasOffGmail && !accountChanged) return;
    showTabBar(true);
    // Load persisted cache on arrival to Gmail or after account switch
    if (wasOffGmail || accountChanged) loadMsgCache(currentAccountPath ?? undefined);
    if (currentTab === "filters") {
      loadLabels(true);
    } else if (currentTab === "summary") {
      showSummary();
    }
    // Start or resume broad cache build in parallel with label fetch
    startBroadBuild();
  } else if (message.type === "labelsReady" && message.labels) {
    cachedLabels = message.labels;
    // Validate and refresh saved label against the current account's labels
    if (activeLabelId !== null) {
      const matchedLabel = cachedLabels.find((l) => l.id === activeLabelId);
      if (!matchedLabel) {
        activeLabelId = null;
        activeLabelName = null;
        saveSetting(KEY_ACTIVE_LABEL, null);
        saveSetting(KEY_ACTIVE_LABEL_NAME, null);
      } else if (matchedLabel.name !== activeLabelName) {
        activeLabelName = matchedLabel.name;
        saveSetting(KEY_ACTIVE_LABEL_NAME, activeLabelName);
      }
    }
    // Apply filters only on initial return to Gmail, not on every label refresh
    if (pendingFilterApply && onGmailPage && currentTab === "filters") {
      pendingFilterApply = false;
      applyFilters();
    }
    refreshLabelsIfVisible();
  } else if (message.type === "labelsError") {
    pendingFilterApply = false;
    if (currentTab === "filters" && onGmailPage && !cachedLabels) showContent('<div class="status">Failed to load labels. Try refreshing the page.</div>');
  } else if (message.type === "notOnGmail") {
    onGmailPage = false;
    cachedLabels = null;
    if (!isShowingHelp()) showHelp();
  } else if (message.type === "messagePageReady" && message.fetchId && message.messages) {
    if (message.fetchId === targetedFetchId) {
      // Targeted fetch: merge into cache, expand relevantLabelIds, un-dim newly found labels
      mergeMessages(message.messages, "targeted");
      saveMsgCache();

      // Track oldest message and update count for progress display
      for (const msg of message.messages) {
        if (targetedOldest === null || msg.internalDate < targetedOldest) targetedOldest = msg.internalDate;
      }
      targetedDoneCount = filterMessages(locationValue, scopeToTimestamp(scopeValue), activeLabelId).length;

      // Expand relevant label IDs from newly fetched messages
      for (const msg of message.messages) {
        for (const lid of msg.labelIds) {
          relevantLabelIds.add(lid);
        }
      }
      if (cachedLabels) relevantLabelIds = addParentChain(relevantLabelIds, cachedLabels);

      if (message.nextPageToken) {
        // Show progress and request next page
        updateCacheProgress();
        refreshLabelsIfVisible();
        if (activePort) activePort.postMessage({ type: "fetchMessagePage", query: targetedQuery, pageToken: message.nextPageToken, fetchId: targetedFetchId });
      } else {
        // Targeted fetch complete
        const cache = getMsgCache();
        if (activeLabelId) {
          const scopeTs = scopeToTimestamp(scopeValue);
          cache.labelOldest[activeLabelId] = scopeTs !== null ? scopeTs : 0;
        }
        saveMsgCache();
        targetedDoneCount = filterMessages(locationValue, scopeToTimestamp(scopeValue), activeLabelId).length;
        targetedFetchId = null;
        targetedInProgress = false;
        dimmedMode = false;
        // Resume broad build with stored pending token
        broadPaused = false;
        if (broadFetchId && broadPendingToken) {
          continueBroadBuild(broadPendingToken);
          broadPendingToken = null;
        }
        refreshLabelsIfVisible();
      }
    } else if (message.fetchId === broadFetchId) {
      // Broad build: merge messages, persist, update progress, re-render filtered labels
      mergeMessages(message.messages);
      saveMsgCache();
      if (message.nextPageToken) {
        continueBroadBuild(message.nextPageToken);
      } else {
        // Broad build complete (only mark complete for full builds, not incremental refreshes)
        const cache = getMsgCache();
        if (!broadQuery.startsWith("after:")) {
          // Full build or backfill complete — all messages fetched
          cache.complete = true;
          saveMsgCache();
          broadFetchId = null;
        } else if (!cache.complete) {
          // Incremental refresh done — backfill older messages only
          saveMsgCache();
          if (cache.broadOldest !== null) {
            const d = new Date(cache.broadOldest);
            d.setDate(d.getDate() + 1);
            broadQuery = `before:${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
          } else {
            broadQuery = "";
          }
          broadFetchId = generateFetchId();
          if (activePort) activePort.postMessage({ type: "fetchMessagePage", query: broadQuery, fetchId: broadFetchId });
        } else {
          saveMsgCache();
          broadFetchId = null;
        }
      }
      refreshLabelsIfVisible();
    }
  } else if (message.type === "messagePageError" && message.fetchId) {
    if (message.fetchId === targetedFetchId) {
      // Stop targeted fetch, fall back to showing all labels
      targetedFetchId = null;
      targetedInProgress = false;
      targetedOldest = null;
      dimmedMode = false;
      relevantLabelIds = new Set();
      broadPaused = false;
      // Resume broad build if it was paused
      if (broadFetchId && broadPendingToken) {
        const token = broadPendingToken;
        broadPendingToken = null;
        continueBroadBuild(token);
      }
      if (currentTab === "filters" && onGmailPage && cachedLabels) renderLabels(cachedLabels);
    } else if (message.fetchId === broadFetchId) {
      broadFetchId = null;
      if (currentTab === "filters" && onGmailPage && cachedLabels) renderLabels(cachedLabels);
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
      chrome.windows.getCurrent().then((win) => { port.postMessage({ type: "initWindow", windowId: win.id }); port.postMessage({ type: "setPinMode", mode: currentPinMode }); syncState(); });
      port.onDisconnect.addListener(() => {
        activePort = null;
        // Service worker may have restarted — old fetch IDs are invalid
        broadFetchId = null;
        broadPaused = false;
        broadPendingToken = null;
        clearTargetedState();
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
