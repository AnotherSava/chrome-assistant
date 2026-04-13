import { escapeHtml } from "@core/icons.js";
import { loadSettings, saveSetting } from "@core/settings.js";
import type { GmailLabel } from "@core/types.js";

interface LabelTreeNode { name: string; fullName: string; id: string; type: string; children: LabelTreeNode[] }

// ---------------------------------------------------------------------------
// Settings keys and defaults
// ---------------------------------------------------------------------------

const SETTINGS_DEFAULTS = {
  ca_active_label: null as string | null,
  ca_active_label_name: null as string | null,
  ca_scope_value: "any",
  ca_label_columns: 3,
  ca_include_children: true,
  ca_show_counts: true,
  ca_show_starred: false,
  ca_show_important: false,
  ca_concurrency: 10,
};

// ---------------------------------------------------------------------------
// State (initialized by init(), called before any rendering)
// ---------------------------------------------------------------------------

let port: chrome.runtime.Port | null = null;

let activeLabelId: string | null = null;
let activeLabelName: string | null = null;
let scopeValue = "any";
let cachedScopeTimestamp: number | null = null;
let labelColumns = 3;
let includeChildren = true;
let showCounts = true;
let showStarred = false;
let showImportant = false;
let concurrency = 10;

let cachedLabels: GmailLabel[] | null = null;
let labelCounts: Record<string, { own: number; inclusive: number }> | null = null;
let lastCacheProgress: { phase: string; labelsTotal: number; labelsDone: number; currentLabel?: string; error?: string } | null = null;
let lastLabelResult: { labelId: string; coLabelCounts: Record<string, number> } | null = null;
/** Whether the last pushed results are partial (initial build in progress) — don't hide zero-count labels from partial results */
let lastResultsPartial = true;
/** Whether labels have been rendered at least once — used to skip labelsReady render on reconnect */
let labelsRendered = false;

const LABELS_HIDDEN = new Set(["CHAT", "DRAFT", "SPAM", "TRASH", "UNREAD", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "YELLOW_STAR", "ORANGE_STAR", "RED_STAR", "PURPLE_STAR", "BLUE_STAR", "GREEN_STAR", "RED_BANG", "ORANGE_GUILLEMET", "YELLOW_BANG", "GREEN_CHECK", "BLUE_INFO", "PURPLE_QUESTION"]);
/** System labels shown in fixed order before user labels */
const SYSTEM_LABEL_ORDER = ["INBOX", "SENT", "STARRED", "IMPORTANT", "NONE"];

/** Load settings from chrome.storage.local and initialize state. Must be called before any rendering. */
export async function init(): Promise<void> {
  const s = await loadSettings(SETTINGS_DEFAULTS);
  activeLabelId = s.ca_active_label;
  activeLabelName = s.ca_active_label_name;
  scopeValue = s.ca_scope_value;
  cachedScopeTimestamp = scopeToTimestamp(scopeValue);
  labelColumns = s.ca_label_columns;
  includeChildren = s.ca_include_children;
  showCounts = s.ca_show_counts;
  showStarred = s.ca_show_starred;
  showImportant = s.ca_show_important;
  concurrency = s.ca_concurrency;

  if (!showStarred) LABELS_HIDDEN.add("STARRED");
  if (!showImportant) LABELS_HIDDEN.add("IMPORTANT");
}

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

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

export function scopeToTimestamp(scopeValue: string): number | null {
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
  // Normalize to start-of-day so the timestamp is day-granular — matching the
  // Gmail `after:YYYY/MM/DD` query.  This ensures the same scope on the same
  // day always produces the same numeric key, preventing duplicate API calls
  // and duplicate scopedIdSets entries in the cache manager.
  const d = fn();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}


// ---------------------------------------------------------------------------
// Public API — port & settings
// ---------------------------------------------------------------------------

export function setPort(p: chrome.runtime.Port | null): void {
  port = p;
}


// ---------------------------------------------------------------------------
// Public API — display settings (called by shell's display panel)
// ---------------------------------------------------------------------------

export function getDisplaySettings(): { labelColumns: number; includeChildren: boolean; showCounts: boolean; showStarred: boolean; showImportant: boolean; concurrency: number } {
  return { labelColumns, includeChildren, showCounts, showStarred, showImportant, concurrency };
}

export function setLabelColumns(value: number): void {
  labelColumns = value;
  saveSetting("ca_label_columns", labelColumns);
}

export function setIncludeChildren(value: boolean): void {
  includeChildren = value;
  saveSetting("ca_include_children", includeChildren);
  // SW reacts via onSettingChanged — re-navigates Gmail and pushes updated results.
  // Local re-render only needed when no label is active (no push will come).
  if (!activeLabelId) refreshLabelsIfVisible();
}

export function setShowCounts(value: boolean): void {
  showCounts = value;
  saveSetting("ca_show_counts", showCounts);
}

export function setShowStarred(value: boolean): void {
  showStarred = value;
  if (showStarred) LABELS_HIDDEN.delete("STARRED"); else LABELS_HIDDEN.add("STARRED");
  saveSetting("ca_show_starred", showStarred);
  if (!showStarred && activeLabelId === "STARRED") selectLabel(null);
  refreshLabelsIfVisible();
}

export function setShowImportant(value: boolean): void {
  showImportant = value;
  if (showImportant) LABELS_HIDDEN.delete("IMPORTANT"); else LABELS_HIDDEN.add("IMPORTANT");
  saveSetting("ca_show_important", showImportant);
  if (!showImportant && activeLabelId === "IMPORTANT") selectLabel(null);
  refreshLabelsIfVisible();
}

export function setConcurrency(value: number): void {
  concurrency = value;
  saveSetting("ca_concurrency", concurrency);
}

export function setScopeValue(value: string): void {
  scopeValue = value;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function sendSelectionChanged(): void {
  if (!port) return;
  updateCacheProgress();
  port.postMessage({ type: "selectionChanged", labelId: activeLabelId, scopeTimestamp: cachedScopeTimestamp });
}

// ---------------------------------------------------------------------------
// Label tree building
// ---------------------------------------------------------------------------

function buildLabelTree(labels: GmailLabel[]): LabelTreeNode[] {
  const visible = labels.filter((l) => !LABELS_HIDDEN.has(l.id) && !LABELS_HIDDEN.has(l.name));
  visible.sort((a, b) => {
    const aSystem = SYSTEM_LABEL_ORDER.indexOf(a.id);
    const bSystem = SYSTEM_LABEL_ORDER.indexOf(b.id);
    if (aSystem !== -1 && bSystem !== -1) return aSystem - bSystem;
    if (aSystem !== -1) return -1;
    if (bSystem !== -1) return 1;
    if (a.type !== b.type) return a.type === "system" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const labelNames = new Set(visible.map((l) => l.name));
  const root: LabelTreeNode[] = [];
  const nodeMap = new Map<string, LabelTreeNode>();

  for (const label of visible) {
    const parts = label.name.split("/");
    let isNested = parts.length > 1;
    if (isNested) {
      for (let i = 1; i < parts.length; i++) {
        if (!labelNames.has(parts.slice(0, i).join("/"))) { isNested = false; break; }
      }
    }

    if (!isNested) {
      const node: LabelTreeNode = { name: label.name, fullName: label.name, id: label.id, type: label.type, children: [] };
      nodeMap.set(label.name, node);
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parentNode = nodeMap.get(parentPath);
      if (!parentNode) {
        const node: LabelTreeNode = { name: label.name, fullName: label.name, id: label.id, type: label.type, children: [] };
        nodeMap.set(label.name, node);
        root.push(node);
        continue;
      }
      const node: LabelTreeNode = { name: parts[parts.length - 1], fullName: label.name, id: label.id, type: label.type, children: [] };
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

// ---------------------------------------------------------------------------
// Label counts
// ---------------------------------------------------------------------------

function getLabelCount(labelId: string): number | null {
  if (!showCounts) return null;
  if (activeLabelId && lastLabelResult) {
    if (labelId === activeLabelId) {
      // Active label count comes from labelCounts (same source as all other labels)
      if (!labelCounts) return null;
      const entry = labelCounts[labelId];
      if (!entry) return null;
      return includeChildren ? entry.inclusive : entry.own;
    }
    const count = lastLabelResult.coLabelCounts[labelId];
    return count !== undefined ? count : null;
  }
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
        span.textContent = `${count}`;
      } else {
        span = document.createElement("span");
        span.className = "label-count";
        span.textContent = `${count}`;
        link.appendChild(span);
      }
    } else if (span) {
      span.remove();
    }
  });
}

// ---------------------------------------------------------------------------
// Label rendering
// ---------------------------------------------------------------------------

function renderLabelTree(nodes: LabelTreeNode[]): string {
  if (nodes.length === 0) return "";
  const items = nodes.map((node) => {
    const hasChildren = node.children.length > 0;
    const activeClass = node.id === activeLabelId ? " active" : "";
    const systemClass = node.type === "system" ? " system" : "";
    const count = getLabelCount(node.id);
    const countSpan = count !== null ? `<span class="label-count">${count}</span>` : "";
    const displayName = node.type === "system" ? node.name.charAt(0) + node.name.slice(1).toLowerCase() : node.name.replace(/_+$/, "");
    const link = `<a class="label-link${activeClass}${systemClass}" href="#" data-label-id="${escapeHtml(node.id)}" data-label-name="${escapeHtml(node.fullName)}">${escapeHtml(displayName)}${countSpan}</a>`;
    const children = hasChildren ? `<ul class="label-tree">${renderLabelTree(node.children)}</ul>` : "";
    const nodeClass = node.type === "system" ? "label-node system" : "label-node";
    return `<li class="${nodeClass}">${link}${children}</li>`;
  }).join("");
  return items;
}

function selectLabel(labelId: string | null): void {
  activeLabelId = labelId;
  activeLabelName = labelId ? (cachedLabels?.find(l => l.id === labelId)?.name ?? null) : null;
  saveSetting("ca_active_label", activeLabelId);
  saveSetting("ca_active_label_name", activeLabelName);
  lastLabelResult = null;

  document.querySelectorAll<HTMLElement>(".label-link").forEach((l) => l.classList.remove("active"));
  if (labelId) {
    document.querySelector<HTMLElement>(`.label-link[data-label-id="${CSS.escape(labelId)}"]`)?.classList.add("active");
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

function showContent(html: string): void {
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.innerHTML = html;
}

function renderFilterBar(): string {
  const scopeOptions = SCOPE_OPTIONS.map((o) => `<option value="${o.value}"${o.value === scopeValue ? " selected" : ""}>${o.label}</option>`).join("");
  return `<div class="filter-bar"><span class="filter-item"><label>Scope from:</label><select id="scope-select">${scopeOptions}</select></span><span class="filter-break"></span><div id="cache-progress" class="cache-progress"></div></div>`;
}

function setupFilterBar(): void {
  const scopeSelect = document.getElementById("scope-select") as HTMLSelectElement | null;
  scopeSelect?.addEventListener("change", () => {
    scopeValue = scopeSelect.value;
    cachedScopeTimestamp = scopeToTimestamp(scopeValue);
    saveSetting("ca_scope_value", scopeValue);
    sendSelectionChanged();
  });
}

function renderLabels(labels: GmailLabel[]): void {
  labelsRendered = true;
  try {
    const contentEl = document.getElementById("content");
    if (!contentEl) return;
    const tree = buildLabelTree(labels);
    const columns = splitIntoColumns(tree, labelColumns);
    const columnsHtml = columns.map((col) => `<ul class="label-tree label-column">${renderLabelTree(col)}</ul>`).join("");
    // Preserve the filter bar if it already exists — only replace the label columns
    let filterBar = contentEl.querySelector(".filter-bar");
    if (filterBar) {
      let labelColumnsEl = contentEl.querySelector(".label-columns");
      if (labelColumnsEl) {
        labelColumnsEl.innerHTML = columnsHtml;
      } else {
        labelColumnsEl = document.createElement("div");
        labelColumnsEl.className = "label-columns";
        labelColumnsEl.innerHTML = columnsHtml;
        contentEl.appendChild(labelColumnsEl);
      }
    } else {
      showContent(`${renderFilterBar()}<div class="label-columns">${columnsHtml}</div>`);
      setupFilterBar();
    }
    setupLabelHandlers();
    updateCacheProgress();
  } catch (err) {
    showContent(`<div class="status">Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`);
  }
}

// ---------------------------------------------------------------------------
// Label filtering
// ---------------------------------------------------------------------------

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
  if (!activeLabelId || !lastLabelResult || lastResultsPartial) {
    // No label selected or no query result yet
    // When scope is active and labelCounts is available, hide zero-count labels.
    // Skip filtering for partial results (initial build in progress) — counts are incomplete.
    if (scopeValue !== "any" && labelCounts && Object.keys(labelCounts).length > 0 && !lastResultsPartial) {
      const visibleIds = new Set(Object.keys(labelCounts));
      const withParents = addParentChain(visibleIds, cachedLabels);
      const filtered = cachedLabels.filter(l => withParents.has(l.id));
      renderLabels(filtered.length > 0 ? filtered : cachedLabels);
    } else {
      renderLabels(cachedLabels);
    }
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

// ---------------------------------------------------------------------------
// Cache progress
// ---------------------------------------------------------------------------

function updateCacheProgress(): void {
  const el = document.getElementById("cache-progress");
  if (!el) return;

  const textParts: string[] = [];
  let showSpinner = false;
  let errorText: string | null = null;

  if (lastCacheProgress && lastCacheProgress.phase === "labels") {
    textParts.push(`Fetching labels ${lastCacheProgress.labelsDone}/${lastCacheProgress.labelsTotal}`);
    showSpinner = true;
  } else if (lastCacheProgress && lastCacheProgress.phase === "scope") {
    const count = lastCacheProgress.labelsDone > 0 ? ` ${lastCacheProgress.labelsDone}` : "";
    textParts.push(`Fetching scope${count}`);
    showSpinner = true;
  }

  if (lastCacheProgress?.error) errorText = lastCacheProgress.error;

  let textEl = el.querySelector(".cache-text") as HTMLSpanElement | null;
  let spinEl = el.querySelector(".cache-spin") as HTMLSpanElement | null;
  let errEl = el.querySelector(".cache-error") as HTMLSpanElement | null;

  if (showSpinner) {
    if (!spinEl) { spinEl = document.createElement("span"); spinEl.className = "cache-spin"; spinEl.textContent = "\u25E0"; el.prepend(spinEl); }
  } else if (spinEl) {
    spinEl.remove();
  }

  const text = textParts.join(" | ");
  if (text) {
    if (!textEl) { textEl = document.createElement("span"); textEl.className = "cache-text"; el.appendChild(textEl); }
    textEl.textContent = text;
  } else if (textEl) {
    textEl.remove();
  }

  if (errorText) {
    if (!errEl) { errEl = document.createElement("span"); errEl.className = "cache-error"; errEl.textContent = "\u26A0"; el.appendChild(errEl); }
    errEl.title = errorText;
  } else if (errEl) {
    errEl.remove();
  }

  if (!text && !showSpinner && !errorText) {
    el.textContent = "";
  }
}

// ---------------------------------------------------------------------------
// Public API — tab lifecycle
// ---------------------------------------------------------------------------

function refreshLabelsIfVisible(): void {
  if (isActive && cachedLabels) renderFilteredLabels();
}

let isActive = true;

/** Called when the search tab becomes visible. */
export function activate(): void {
  isActive = true;
  if (cachedLabels) {
    sendSelectionChanged();
    renderFilteredLabels();
  } else {
    showContent('<div class="status">Loading labels...</div>');
  }
}

/** Called when the search tab is hidden (e.g., switching to another tab). */
export function deactivate(): void {
  isActive = false;
}

/** Render cached labels if available, or show loading placeholder. Labels are pushed proactively by the service worker — no fetch request needed. */
export function renderIfReady(): void {
  if (cachedLabels) {
    renderFilteredLabels();
  } else {
    showContent('<div class="status">Loading labels...</div>');
  }
}

/** Reset search tab state (account change, navigated away from Gmail). */
export function reset(): void {
  cachedLabels = null;
  labelCounts = null;
  activeLabelId = null;
  activeLabelName = null;
  lastLabelResult = null;
  lastCacheProgress = null;
  labelsRendered = false;
  saveSetting("ca_active_label", null);
  saveSetting("ca_active_label_name", null);
}

// ---------------------------------------------------------------------------
// Public API — message handling (returns true if handled)
// ---------------------------------------------------------------------------

export function handleMessage(message: { type: string; labels?: GmailLabel[]; phase?: string; labelsTotal?: number; labelsDone?: number; currentLabel?: string; errorText?: string; labelId?: string; coLabelCounts?: Record<string, number>; counts?: Record<string, { own: number; inclusive: number }>; filterConfig?: Record<string, unknown>; partial?: boolean }): boolean {
  if (message.type === "labelsReady" && message.labels) {
    cachedLabels = message.labels;
    if (message.counts) labelCounts = message.counts;
    // Validate and refresh saved label against the current account's labels
    if (activeLabelId !== null) {
      const matchedLabel = cachedLabels.find((l) => l.id === activeLabelId);
      if (!matchedLabel || LABELS_HIDDEN.has(activeLabelId)) {
        activeLabelId = null;
        activeLabelName = null;
        saveSetting("ca_active_label", null);
        saveSetting("ca_active_label_name", null);
      } else if (matchedLabel.name !== activeLabelName) {
        activeLabelName = matchedLabel.name;
        saveSetting("ca_active_label_name", activeLabelName);
      }
    }
    // If labels are already displayed, keep the current view — filterResults will
    // re-render with fresh data. If nothing is displayed yet, render immediately.
    if (!labelsRendered) refreshLabelsIfVisible();
    return true;
  }


  if (message.type === "filterResults") {
    const fc = message.filterConfig as { labelId?: string | null; scopeTimestamp?: number | null; includeChildren?: boolean } | undefined;
    let countsChanged = false;
    let labelResultChanged = false;
    if (!fc || fc.scopeTimestamp === cachedScopeTimestamp) {
      if (message.counts) {
        labelCounts = message.counts;
        countsChanged = true;
      }
      lastResultsPartial = !!message.partial;
    }
    if (message.labelId !== undefined && message.labelId !== null && message.labelId === activeLabelId && (!fc || (fc.labelId === activeLabelId && fc.scopeTimestamp === cachedScopeTimestamp && fc.includeChildren === includeChildren))) {
      lastLabelResult = { labelId: message.labelId, coLabelCounts: message.coLabelCounts ?? {} };
      labelResultChanged = true;
    }
    if (labelResultChanged || (countsChanged && !lastResultsPartial)) {
      refreshLabelsIfVisible();
    } else if (countsChanged) {
      updateCountsInPlace();
    }
    updateCacheProgress();
    return true;
  }

  if (message.type === "cacheState") {
    lastCacheProgress = { phase: message.phase ?? "labels", labelsTotal: message.labelsTotal ?? 0, labelsDone: message.labelsDone ?? 0, currentLabel: message.currentLabel, error: message.errorText };
    updateCacheProgress();
    return true;
  }

  if (message.type === "fetchError") {
    showContent('<div class="status">Failed to fetch emails. Try refreshing the page.</div>');
    return true;
  }

  return false;
}

/** Send the current selection state to the background. */
export function sendSelection(): void {
  sendSelectionChanged();
}
