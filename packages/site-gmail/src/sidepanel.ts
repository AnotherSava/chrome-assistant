import { renderHelp } from "./help.js";
import { escapeHtml, ICON_PANEL, ICON_PANEL_1 } from "@core/icons.js";
import { loadSetting, saveSetting } from "@core/settings.js";
import type { PinMode, GmailLabel } from "@core/types.js";
interface LabelTreeNode { name: string; fullName: string; id: string | null; children: LabelTreeNode[] }

let currentTab: "summary" | "labels" = "labels";
let activeLabelId: string | null = null;
let onGmailPage = false;

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
  chrome.runtime.sendMessage({ type: "setPinMode", mode }).catch(() => {});
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
  link.addEventListener("mouseup", (e: MouseEvent) => { e.stopPropagation(); navigator.clipboard.writeText("chrome://extensions/shortcuts").catch(() => {}); link.textContent = "Copied URL — paste in address bar"; closePinDropdown(); });
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
let labelColumns: number = loadSetting(KEY_LABEL_COLUMNS, 3);
let scopeValue: string = loadSetting(KEY_SCOPE_VALUE, "any");
let locationValue: string = loadSetting(KEY_LOCATION, "inbox");

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
  panel.innerHTML = `<div class="display-row"><label>Columns</label><select id="col-select">${colOptions}</select></div>`;
  const colSelect = document.getElementById("col-select") as HTMLSelectElement;
  colSelect.addEventListener("change", () => {
    labelColumns = parseInt(colSelect.value, 10);
    saveSetting(KEY_LABEL_COLUMNS, labelColumns);
    if (currentTab === "labels") loadLabels();
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

function switchTab(tab: "summary" | "labels"): void {
  currentTab = tab;
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "summary") {
    showContent('<div class="status">Summary is coming soon...</div>');
  } else {
    loadLabels();
  }
}

document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
  t.addEventListener("click", () => { switchTab(t.dataset.tab as "summary" | "labels"); });
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
      // Nested label — walk the tree
      let parent = root;
      let path = "";
      for (let i = 0; i < parts.length; i++) {
        path = path ? path + "/" + parts[i] : parts[i];
        let node = nodeMap.get(path);
        if (!node) {
          node = { name: parts[i], fullName: path, id: i === parts.length - 1 ? label.id : null, children: [] };
          nodeMap.set(path, node);
          parent.push(node);
        }
        if (i === parts.length - 1) node.id = label.id;
        parent = node.children;
      }
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
    const link = `<a class="label-link${activeClass}" href="#" data-label-id="${escapeHtml(node.id ?? node.fullName)}" data-label-name="${escapeHtml(node.fullName)}">${escapeHtml(node.name)}</a>`;
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
      if (activeLabelId === labelId) {
        activeLabelId = null;
        applyFilters();
      } else {
        activeLabelId = labelId;
        link.classList.add("active");
        applyFilters();
      }
    });
  });
}

function scopeToDate(): string | null {
  if (scopeValue === "any") return null;
  const now = new Date();
  const map: Record<string, () => Date> = {
    "1w": () => new Date(now.getTime() - 7 * 86400000),
    "2w": () => new Date(now.getTime() - 14 * 86400000),
    "1m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d; },
    "2m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 2); return d; },
    "6m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 6); return d; },
    "1y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d; },
    "3y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); return d; },
    "5y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); return d; },
  };
  const fn = map[scopeValue];
  if (!fn) return null;
  const d = fn();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function applyFilters(): void {
  if (!chrome.runtime?.sendMessage) return;
  const activeLink = activeLabelId ? Array.from(document.querySelectorAll<HTMLElement>(".label-link")).find((el) => el.dataset.labelId === activeLabelId) ?? null : null;
  const labelName = activeLink?.dataset.labelName ?? null;
  const scope = scopeToDate();
  chrome.runtime.sendMessage({ type: "applyFilters", location: locationValue, labelName, scope }).catch(() => {});
}

function renderFilterBar(): string {
  const locOptions = LOCATION_OPTIONS.map((o) => `<option value="${o.value}"${o.value === locationValue ? " selected" : ""}>${o.label}</option>`).join("");
  const scopeOptions = SCOPE_OPTIONS.map((o) => `<option value="${o.value}"${o.value === scopeValue ? " selected" : ""}>${o.label}</option>`).join("");
  return `<div class="filter-bar"><span class="filter-item"><label>Location:</label><select id="location-select">${locOptions}</select></span><span class="filter-break"></span><span class="filter-item"><label>Scope from:</label><select id="scope-select">${scopeOptions}</select></span></div>`;
}

function setupFilterBar(): void {
  const locSelect = document.getElementById("location-select") as HTMLSelectElement | null;
  locSelect?.addEventListener("change", () => {
    locationValue = locSelect.value;
    saveSetting(KEY_LOCATION, locationValue);
    applyFilters();
  });
  const scopeSelect = document.getElementById("scope-select") as HTMLSelectElement | null;
  scopeSelect?.addEventListener("change", () => {
    scopeValue = scopeSelect.value;
    saveSetting(KEY_SCOPE_VALUE, scopeValue);
    applyFilters();
  });
}

let cachedLabels: GmailLabel[] | null = null;

function renderLabels(labels: GmailLabel[]): void {
  switchZoomContext("gmail");
  const tree = buildLabelTree(labels);
  const columns = splitIntoColumns(tree, labelColumns);
  const columnsHtml = columns.map((col) => `<ul class="label-tree label-column">${renderLabelTree(col)}</ul>`).join("");
  showContent(`${renderFilterBar()}<div class="label-columns">${columnsHtml}</div>`);
  setupFilterBar();
  setupLabelHandlers();
}

function loadLabels(forceRefresh: boolean = false): void {
  if (cachedLabels && !forceRefresh) {
    renderLabels(cachedLabels);
    return;
  }
  // Show loading only if we have nothing to display yet
  if (!cachedLabels) showContent('<div class="status">Loading labels...</div>');
  (chrome.runtime.sendMessage({ type: "fetchLabels" }) as Promise<{ labels: GmailLabel[] }>).then((response) => {
    cachedLabels = response?.labels ?? [];
    renderLabels(cachedLabels);
  }).catch(() => { showContent('<div class="status">Failed to load labels. Try refreshing.</div>'); });
}

// ---------------------------------------------------------------------------
// Help page
// ---------------------------------------------------------------------------

let showingHelp = false;

function showHelp(): void {
  switchZoomContext("help");
  showTabBar(false);
  showingHelp = true;
  showContent(renderHelp());
}

function returnFromHelp(): void {
  showingHelp = false;
  if (onGmailPage) {
    showTabBar(true);
    if (currentTab === "labels") loadLabels();
  }
}

document.getElementById("btn-help")?.addEventListener("click", () => {
  if (showingHelp) {
    returnFromHelp();
  } else {
    showHelp();
  }
});

// ---------------------------------------------------------------------------
// Port connection to background (messages received via port.onMessage)
// ---------------------------------------------------------------------------

function handleMessage(message: { type: string }): void {
  if (message.type === "resultsReady") {
    onGmailPage = true;
    if (showingHelp) return;
    showTabBar(true);
    if (currentTab === "labels") loadLabels(true);
  } else if (message.type === "notOnGmail") {
    onGmailPage = false;
    activeLabelId = null;
    cachedLabels = null;
    if (!showingHelp) showHelp();
  } else if (message.type === "fetchError") {
    showContent('<div class="status">Failed to fetch emails. Try refreshing the page.</div>');
  }
}

if (chrome.runtime?.connect) {
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  const connectToBackground = (): void => {
    if (!chrome.runtime?.id) return;
    try {
      const port = chrome.runtime.connect(undefined, { name: "sidepanel" });
      reconnectDelay = 1000;
      port.onMessage.addListener(handleMessage);
      chrome.runtime.sendMessage({ type: "setPinMode", mode: currentPinMode }).catch(() => {});
      port.onDisconnect.addListener(() => {
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
