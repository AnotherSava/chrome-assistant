import { escapeHtml, ICON_ARCHIVE, ICON_TRASH } from "@core/icons.js";
import type { GmailLabel } from "@core/types.js";
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

const PANE_ID = "sub-deals";
const TARGET_LABEL_NAMES = ["ads/deal", "pending"];

let port: chrome.runtime.Port | null = null;
let cachedLabels: GmailLabel[] | null = null;
let accountPath: string = "/mail/u/0/";
let isActive = false;
let renderGeneration = 0;
let lastRenderedLabelKey: string | null = null;
let lastCount: number | null = null;
let countListener: ((count: number | null) => void) | null = null;
let activeRowKey: string | null = null;
let lastFetchError: string | null = null;
let lastFetchHint: ErrorHint | null = null;
let currentRecords: DealsCacheRecord[] = [];
let pendingLabelId: string | null = null;
let dealLabelId: string | null = null;
const pendingRequests = new Map<string, (ids: string[]) => void>();

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

export function setLabels(labels: GmailLabel[] | null): void {
  cachedLabels = labels;
  if (labels !== null) { lastFetchError = null; lastFetchHint = null; }
}

export function setAccountPath(path: string): void {
  accountPath = path;
}

export function setGmailHash(_hash: string, isListView: boolean): void {
  // Gmail rewrites the message hash to its own internal ID, so we can't match by hash.
  // Instead, keep the clicked row highlighted until Gmail navigates to a list view.
  if (isListView) activeRowKey = null;
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

function findTargetLabels(): GmailLabel[] {
  if (!cachedLabels) return [];
  const wanted = new Set(TARGET_LABEL_NAMES.map((n) => n.toLowerCase()));
  return cachedLabels.filter((l) => wanted.has(l.name.toLowerCase()));
}

function requestLabelMessageIds(labelId: string): Promise<string[]> {
  if (!port) return Promise.resolve([]);
  const requestId = `deals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<string[]>((resolve) => {
    pendingRequests.set(requestId, resolve);
    try {
      port!.postMessage({ type: "getLabelMessageIds", labelId, requestId });
    } catch {
      pendingRequests.delete(requestId);
      resolve([]);
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
  if (!port || !cachedLabels) return;
  const labels = findTargetLabels();
  if (labels.length < TARGET_LABEL_NAMES.length) return;
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
  sendGmailRefresh();
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
  sendGmailRefresh();
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

  if (!cachedLabels) {
    if (lastFetchError) renderErrorState(lastFetchError, lastFetchHint);
    else renderEmptyState("Loading labels…");
    return;
  }
  const labels = findTargetLabels();
  if (labels.length < TARGET_LABEL_NAMES.length) {
    lastRenderedLabelKey = null;
    setCount(null);
    const present = new Set(labels.map((l) => l.name.toLowerCase()));
    const missing = TARGET_LABEL_NAMES.filter((n) => !present.has(n.toLowerCase()));
    renderEmptyState(`Missing label${missing.length === 1 ? "" : "s"}: ${missing.map((n) => `"${n}"`).join(", ")}.`);
    return;
  }
  pendingLabelId = labels.find((l) => l.name.toLowerCase() === "pending")?.id ?? null;
  dealLabelId = labels.find((l) => l.name.toLowerCase() === "ads/deal")?.id ?? null;
  const labelKey = labels.map((l) => l.id).sort().join(",");
  if (lastRenderedLabelKey === labelKey && document.getElementById(PANE_ID)?.querySelector(".summary-list")) {
    return;
  }

  showContent('<div class="status" id="deals-loading">Loading…</div>');

  const idLists = await Promise.all(labels.map((l) => requestLabelMessageIds(l.id)));
  if (generation !== renderGeneration || !isActive) return;
  let intersection = new Set(idLists[0] ?? []);
  for (let i = 1; i < idLists.length; i++) {
    const next = new Set(idLists[i]);
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
  cachedLabels = null;
  lastRenderedLabelKey = null;
  renderGeneration++;
  pendingRequests.clear();
  setCount(null);
  activeRowKey = null;
  lastFetchError = null;
  lastFetchHint = null;
  currentRecords = [];
  pendingLabelId = null;
  dealLabelId = null;
}

export function handleMessage(message: { type: string; requestId?: string; ids?: string[]; errorText?: string; hint?: ErrorHint | null }): boolean {
  if (message.type === "labelMessageIds" && message.requestId !== undefined) {
    const resolver = pendingRequests.get(message.requestId);
    if (resolver) {
      pendingRequests.delete(message.requestId);
      resolver(message.ids ?? []);
      return true;
    }
  }
  if (message.type === "fetchError") {
    lastRenderedLabelKey = null;
    renderGeneration++;
    lastFetchError = message.errorText ?? "Failed to load labels.";
    lastFetchHint = message.hint ?? null;
    if (isActive) renderErrorState(lastFetchError, lastFetchHint);
    return true;
  }
  return false;
}
