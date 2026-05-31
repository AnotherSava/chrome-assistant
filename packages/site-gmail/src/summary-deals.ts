import { escapeHtml, ICON_ARCHIVE, ICON_TRASH } from "@core/icons.js";
import { buildErrorHtml, type ErrorHint } from "@core/error-display.js";
import { fetchMessagesFull, archiveMessages, unarchiveMessages, trashMessages, untrashMessages, formatLabelForQuery } from "./gmail-api.js";
import { extractExpiryDate } from "./expiry.js";
import { extractMaxDiscount } from "./discount.js";
import { getSummaryRecords, putSummaryRecords, deleteSummaryRecords, removeFromLabelIndex, addToLabelIndex, SUMMARY_DEALS_STORE } from "./cache-db.js";
import { pushUndo } from "./undo-stack.js";

export interface DealsCacheRecord {
  messageId: string;
  threadId: string;
  fromName: string;
  subject: string;
  date: number;
  expiry: number | null;
  discount: number | null;
}

/** A name→ID resolution from the background, plus the cached message IDs in that label. */
interface LabelLookup { labelId: string | null; ids: string[] }

const PANE_ID = "sub-deals";
const TARGET_LABEL_NAMES = ["ads/deal", "pending"];

let port: chrome.runtime.Port | null = null;
let accountPath: string = "/mail/u/0/";
let isActive = false;
let renderGeneration = 0;
let lastRenderedLabelKey: string | null = null;
let lastCount: number | null = null;
let countListener: ((count: number | null) => void) | null = null;
let activeRowKey: string | null = null;
let lastFetchError: string | null = null;
let lastFetchHint: ErrorHint | null = null;
let lastCacheError: string | null = null;
let currentRecords: DealsCacheRecord[] = [];
let pendingLabelId: string | null = null;
let dealLabelId: string | null = null;
let filterSentToGmail = false;
const pendingRequests = new Map<string, (result: LabelLookup) => void>();

export function setOnCount(fn: ((count: number | null) => void) | null): void {
  countListener = fn;
  if (fn) fn(lastCount);
}

function setCount(count: number | null): void {
  if (lastCount === count) return;
  lastCount = count;
  if (countListener) countListener(count);
}

export function setPort(p: chrome.runtime.Port | null): void {
  port = p;
}

export function setAccountPath(path: string): void {
  accountPath = path;
}

export function setGmailHash(_hash: string, isListView: boolean): void {
  const pane = document.getElementById(PANE_ID);
  if (isListView && pane?.querySelector(".summary-row")) activeRowKey = null;
  updateActiveRow();
}

function updateActiveRow(): void {
  const pane = document.getElementById(PANE_ID);
  if (!pane) return;
  pane.querySelectorAll<HTMLElement>(".summary-row").forEach((row) => {
    row.classList.toggle("active", activeRowKey !== null && row.dataset.msgId === activeRowKey);
  });
}

function showContent(html: string): void {
  const pane = document.getElementById(PANE_ID);
  if (pane) pane.innerHTML = html;
}

function requestLabelMessageIds(labelName: string): Promise<LabelLookup> {
  if (!port) return Promise.resolve({ labelId: null, ids: [] });
  const requestId = `deals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<LabelLookup>((resolve) => {
    pendingRequests.set(requestId, resolve);
    try {
      port!.postMessage({ type: "getLabelMessageIds", labelName, requestId });
    } catch {
      pendingRequests.delete(requestId);
      resolve({ labelId: null, ids: [] });
    }
  });
}

function formatDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (sameYear) return `${months[d.getMonth()]} ${d.getDate()}`;
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function extractName(from: string): string {
  if (!from) return "(unknown)";
  const match = from.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  if (match) return match[1].trim();
  return from;
}

function buildMessageUrl(messageId: string): string {
  return `https://mail.google.com${accountPath}#all/${encodeURIComponent(messageId)}`;
}

function buildFilterQuery(): string {
  return TARGET_LABEL_NAMES.map((n) => `label:${formatLabelForQuery(n)}`).join(" ");
}

export function sendGmailFilter(): void {
  if (!port || pendingLabelId === null || dealLabelId === null) return;
  filterSentToGmail = true;
  try {
    port.postMessage({ type: "summaryFilter", query: buildFilterQuery() });
  } catch { /* port may be dead */ }
}

function sendGmailRefresh(): void {
  if (!port) return;
  try {
    port.postMessage({ type: "refreshGmailView" });
  } catch { /* port may be dead */ }
}

function sendGmailInbox(): void {
  if (!port) return;
  try {
    port.postMessage({ type: "filtersOff" });
  } catch { /* port may be dead */ }
}

function navigateBackAfterAction(): void {
  activeRowKey = null;
  if (filterSentToGmail) sendGmailFilter();
  else sendGmailInbox();
}

function renderEmptyState(message: string): void {
  showContent(`<div class="status">${escapeHtml(message)}</div>`);
}

function renderErrorState(message: string, hint: ErrorHint | null = null): void {
  showContent(buildErrorHtml(message, hint));
}

function renderProgress(done: number, total: number): void {
  const el = document.getElementById("deals-loading");
  if (el) el.textContent = `Loading ${done} / ${total}…`;
}

/** Loading placeholder. While the background defers our lookup (cache still building), a cache
 * fetch error is surfaced here as a "retrying" note so a stuck build is visible on this tab too. */
function renderLoading(): void {
  const note = lastCacheError ? `<div class="status-subnote" title="${escapeHtml(lastCacheError)}">⚠ Trouble reaching Gmail — retrying…</div>` : "";
  showContent(`<div class="status" id="deals-loading">Loading…</div>${note}`);
}

function renderRecords(): void {
  const sorted = [...currentRecords].sort((a, b) => {
    if (a.expiry !== null && b.expiry !== null) return b.expiry - a.expiry;
    if (a.expiry !== null) return -1;
    if (b.expiry !== null) return 1;
    return b.date - a.date;
  });
  setCount(sorted.length);
  if (sorted.length === 0) {
    showContent('<div class="status">No emails in this label.</div>');
    return;
  }
  const rows = sorted.map((r) => {
    const subject = r.subject || "(no subject)";
    const expiryLabel = r.expiry !== null ? formatDate(r.expiry) : "?";
    const discountLabel = r.discount !== null ? `$${r.discount}` : "";
    const actions = `<span class="row-actions"><button class="row-action-btn" data-action="archive" data-message-id="${escapeHtml(r.messageId)}" title="Archive (remove pending)">${ICON_ARCHIVE}</button><button class="row-action-btn" data-action="delete" data-message-id="${escapeHtml(r.messageId)}" title="Move to Trash">${ICON_TRASH}</button></span>`;
    return `<div class="summary-row deals-row" data-msg-id="${escapeHtml(r.threadId)}"><span class="summary-from">${escapeHtml(r.fromName)}</span><span class="summary-subject"><span class="subject-text">${escapeHtml(subject)}</span>${actions}</span><span class="summary-discount">${escapeHtml(discountLabel)}</span><span class="summary-date">${escapeHtml(expiryLabel)}</span></div>`;
  }).join("");
  showContent(`<div class="summary-list deals">${rows}</div>`);
  const pane = document.getElementById(PANE_ID);
  if (!pane) return;
  pane.querySelectorAll<HTMLElement>(".summary-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.msgId;
      if (!id) return;
      activeRowKey = id;
      updateActiveRow();
      openMessage(id);
    });
  });
  pane.querySelectorAll<HTMLButtonElement>(".row-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const messageId = btn.dataset.messageId;
      const action = btn.dataset.action;
      if (!messageId) return;
      const record = currentRecords.find((r) => r.messageId === messageId);
      if (!record) return;
      if (action === "archive") void handleArchive(record);
      else if (action === "delete") void handleDelete(record);
    });
  });
  updateActiveRow();
}

function showActionError(message: string): void {
  const pane = document.getElementById(PANE_ID);
  if (!pane) return;
  let banner = pane.querySelector<HTMLElement>(".action-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "action-error-banner";
    pane.insertBefore(banner, pane.firstChild);
  }
  banner.textContent = message;
  const node = banner;
  setTimeout(() => { if (node.parentNode) node.remove(); }, 4000);
}

async function handleArchive(record: DealsCacheRecord): Promise<void> {
  if (!pendingLabelId) return;
  const pendingId = pendingLabelId;
  const messageIds = [record.messageId];
  const originalIndex = currentRecords.indexOf(record);
  const navigateBack = activeRowKey !== null && record.threadId === activeRowKey;
  currentRecords = currentRecords.filter((r) => r.messageId !== record.messageId);
  renderRecords();
  try {
    await archiveMessages(messageIds, pendingId);
  } catch (err) {
    currentRecords.splice(originalIndex >= 0 ? originalIndex : currentRecords.length, 0, record);
    renderRecords();
    showActionError(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await removeFromLabelIndex(pendingId, messageIds);
  await deleteSummaryRecords(SUMMARY_DEALS_STORE, messageIds);
  if (navigateBack) navigateBackAfterAction();
  else sendGmailRefresh();
  pushUndo({
    label: `Archive: ${record.subject || "(no subject)"}`,
    undo: async () => {
      try {
        await unarchiveMessages(messageIds, pendingId);
      } catch (err) {
        showActionError(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      await addToLabelIndex(pendingId, messageIds);
      await putSummaryRecords(SUMMARY_DEALS_STORE, [record]);
      currentRecords = [...currentRecords, record];
      renderRecords();
      sendGmailRefresh();
    },
  });
}

async function handleDelete(record: DealsCacheRecord): Promise<void> {
  const messageIds = [record.messageId];
  const originalIndex = currentRecords.indexOf(record);
  const pendingId = pendingLabelId;
  const dealId = dealLabelId;
  const navigateBack = activeRowKey !== null && record.threadId === activeRowKey;
  currentRecords = currentRecords.filter((r) => r.messageId !== record.messageId);
  renderRecords();
  try {
    await trashMessages(messageIds);
  } catch (err) {
    currentRecords.splice(originalIndex >= 0 ? originalIndex : currentRecords.length, 0, record);
    renderRecords();
    showActionError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (pendingId) await removeFromLabelIndex(pendingId, messageIds);
  if (dealId) await removeFromLabelIndex(dealId, messageIds);
  await deleteSummaryRecords(SUMMARY_DEALS_STORE, messageIds);
  if (navigateBack) navigateBackAfterAction();
  else sendGmailRefresh();
  pushUndo({
    label: `Delete: ${record.subject || "(no subject)"}`,
    undo: async () => {
      try {
        await untrashMessages(messageIds);
      } catch (err) {
        showActionError(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (pendingId) await addToLabelIndex(pendingId, messageIds);
      if (dealId) await addToLabelIndex(dealId, messageIds);
      await putSummaryRecords(SUMMARY_DEALS_STORE, [record]);
      currentRecords = [...currentRecords, record];
      renderRecords();
      sendGmailRefresh();
    },
  });
}

function openMessage(messageId: string): void {
  if (!port) return;
  try {
    port.postMessage({ type: "openMessage", url: buildMessageUrl(messageId) });
  } catch { /* port may be dead */ }
}

export async function activate(): Promise<void> {
  isActive = true;
  const generation = ++renderGeneration;

  // Show the sticky fetch error if we have one, else a loading placeholder (only when
  // nothing is rendered yet — the background may defer the reply until labels load, and we
  // don't want to blank an existing list). Always (re)issue the request regardless, so a
  // recovered orchestrator re-populates us without needing a separate re-activation.
  const hadList = document.getElementById(PANE_ID)?.querySelector(".summary-list") !== null;
  if (lastFetchError) renderErrorState(lastFetchError, lastFetchHint);
  else if (!hadList) renderLoading();

  // Resolve both target labels by name in parallel — lookups stay aligned with TARGET_LABEL_NAMES.
  const lookups = await Promise.all(TARGET_LABEL_NAMES.map((name) => requestLabelMessageIds(name)));
  if (generation !== renderGeneration || !isActive) return;
  const missing = TARGET_LABEL_NAMES.filter((_, i) => lookups[i].labelId === null);
  if (missing.length > 0) {
    lastRenderedLabelKey = null;
    pendingLabelId = null;
    dealLabelId = null;
    setCount(null);
    renderEmptyState(`Missing label${missing.length === 1 ? "" : "s"}: ${missing.map((n) => `"${n}"`).join(", ")}.`);
    return;
  }
  // A real resolution means labels loaded fine — clear any sticky fetch error.
  lastFetchError = null;
  lastFetchHint = null;
  dealLabelId = lookups[TARGET_LABEL_NAMES.indexOf("ads/deal")].labelId;
  pendingLabelId = lookups[TARGET_LABEL_NAMES.indexOf("pending")].labelId;
  const labelKey = lookups.map((l) => l.labelId).sort().join(",");
  if (lastRenderedLabelKey === labelKey && hadList) return;
  renderLoading();

  let intersection = new Set(lookups[0].ids);
  for (let i = 1; i < lookups.length; i++) {
    const next = new Set(lookups[i].ids);
    intersection = new Set([...intersection].filter((id) => next.has(id)));
  }
  const ids = [...intersection];
  if (ids.length === 0) {
    currentRecords = [];
    renderRecords();
    return;
  }

  try {
    const cached = await getSummaryRecords<DealsCacheRecord>(SUMMARY_DEALS_STORE, ids);
    if (generation !== renderGeneration || !isActive) return;
    const missingIds = ids.filter((id) => !cached.has(id));

    if (missingIds.length > 0) {
      const fetched = await fetchMessagesFull(missingIds, 5, (done, total) => {
        if (generation === renderGeneration && isActive) renderProgress(done, total);
      });
      if (generation !== renderGeneration || !isActive) return;
      const newRecords: DealsCacheRecord[] = fetched.map((m) => {
        const text = `${m.subject} ${m.body}`;
        return { messageId: m.id, threadId: m.threadId, fromName: extractName(m.from), subject: m.subject, date: m.date, expiry: extractExpiryDate(text), discount: extractMaxDiscount(text) };
      });
      await putSummaryRecords(SUMMARY_DEALS_STORE, newRecords);
      for (const r of newRecords) cached.set(r.messageId, r);
    }

    currentRecords = ids.map((id) => cached.get(id)).filter((r): r is DealsCacheRecord => r !== undefined);
    renderRecords();
    lastRenderedLabelKey = labelKey;
  } catch (err) {
    if (generation !== renderGeneration || !isActive) return;
    renderErrorState(`Failed to load emails: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deactivate(): void {
  isActive = false;
  renderGeneration++;
}

export function reset(): void {
  lastRenderedLabelKey = null;
  renderGeneration++;
  pendingRequests.clear();
  setCount(null);
  activeRowKey = null;
  lastFetchError = null;
  lastFetchHint = null;
  lastCacheError = null;
  currentRecords = [];
  pendingLabelId = null;
  dealLabelId = null;
  filterSentToGmail = false;
}

export function handleMessage(message: { type: string; requestId?: string; labelId?: string | null; ids?: string[]; errorText?: string; hint?: ErrorHint | null }): boolean {
  if (message.type === "labelMessageIds" && message.requestId !== undefined) {
    const resolver = pendingRequests.get(message.requestId);
    if (resolver) {
      pendingRequests.delete(message.requestId);
      resolver({ labelId: message.labelId ?? null, ids: message.ids ?? [] });
      return true;
    }
  }
  if (message.type === "fetchError") {
    // Don't bump renderGeneration: leave the in-flight activate's request alive so a later
    // recovery (orchestrator restart flushing the queued lookup) resolves it and re-renders.
    lastRenderedLabelKey = null;
    lastFetchError = message.errorText ?? "Failed to load labels.";
    lastFetchHint = message.hint ?? null;
    if (isActive) renderErrorState(lastFetchError, lastFetchHint);
    return true;
  }
  if (message.type === "cacheState") {
    // Track the cache's current fetch error so a stuck/erroring build is surfaced in our
    // loading placeholder (clears automatically when the next progress event has no error).
    const err = message.errorText ?? null;
    if (err !== lastCacheError) {
      lastCacheError = err;
      if (isActive && document.getElementById("deals-loading")) renderLoading();
    }
    return false;
  }
  return false;
}
