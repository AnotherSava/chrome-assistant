import { escapeHtml, ICON_ARCHIVE, ICON_TRASH } from "@core/icons.js";
import type { GmailLabel } from "@core/types.js";
import { buildErrorHtml, type ErrorHint } from "@core/error-display.js";
import { fetchMessagesMetadata, formatLabelForQuery, archiveMessages, unarchiveMessages, trashMessages, untrashMessages } from "./gmail-api.js";
import { getSummaryRecords, putSummaryRecords, deleteSummaryRecords, removeFromLabelIndex, addToLabelIndex, SUMMARY_REMINDERS_STORE } from "./cache-db.js";
import { pushUndo } from "./undo-stack.js";

export interface RemindersCacheRecord {
  messageId: string;
  threadId: string;
  subject: string;
  date: number;
}

interface ReminderGroup { subject: string; count: number; latestDate: number; threadId: string | null }

const PANE_ID = "sub-reminders";
const TARGET_LABEL_NAME = "remind";

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
let currentRecords: RemindersCacheRecord[] = [];
let remindLabelId: string | null = null;
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

export function setGmailHash(hash: string, isListView: boolean): void {
  const pane = document.getElementById(PANE_ID);
  // Grouped rows: match the search URL Gmail preserves verbatim.
  if (pane && hash) {
    const groupRow = [...pane.querySelectorAll<HTMLElement>(".summary-row[data-match-hash]")].find((row) => {
      const mh = row.dataset.matchHash;
      return mh !== undefined && (hash === mh || hash.startsWith(mh + "/"));
    });
    if (groupRow) {
      activeRowKey = groupRow.dataset.matchHash ?? null;
      updateActiveRow();
      return;
    }
  }
  // Single-message rows: Gmail rewrites the URL ID, so keep the clicked row highlighted
  // until Gmail navigates to a list view (Inbox, label, etc.).
  if (isListView) activeRowKey = null;
  updateActiveRow();
}

function updateActiveRow(): void {
  const pane = document.getElementById(PANE_ID);
  if (!pane) return;
  pane.querySelectorAll<HTMLElement>(".summary-row").forEach((row) => {
    const key = row.dataset.matchHash ?? row.dataset.msgId ?? null;
    row.classList.toggle("active", activeRowKey !== null && key === activeRowKey);
  });
}

function showContent(html: string): void {
  const pane = document.getElementById(PANE_ID);
  if (pane) pane.innerHTML = html;
}

function findTargetLabel(): GmailLabel | null {
  if (!cachedLabels) return null;
  const lower = TARGET_LABEL_NAME.toLowerCase();
  return cachedLabels.find((l) => l.name.toLowerCase() === lower) ?? null;
}

function requestLabelMessageIds(labelId: string): Promise<string[]> {
  if (!port) return Promise.resolve([]);
  const requestId = `reminders-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function cleanSubject(subject: string): string {
  let cleaned = subject.replace(/^notification:\s*/i, "");
  const atIdx = cleaned.indexOf(" @ ");
  if (atIdx !== -1) cleaned = cleaned.slice(0, atIdx);
  cleaned = cleaned.trim();
  return cleaned || subject;
}

function buildGroupQuery(subject: string): string {
  const labelClause = `label:${formatLabelForQuery(TARGET_LABEL_NAME)}`;
  const subjectClause = `subject:"${subject.replace(/"/g, "")}"`;
  return `${labelClause} ${subjectClause}`;
}

function buildGroupSearchUrl(subject: string): string {
  return `https://mail.google.com${accountPath}#search/${encodeURIComponent(buildGroupQuery(subject))}`;
}

function buildGroupMatchHash(subject: string): string {
  return `search/${buildGroupQuery(subject)}`;
}

function buildMessageUrl(messageId: string): string {
  return `https://mail.google.com${accountPath}#all/${encodeURIComponent(messageId)}`;
}

function buildFilterQuery(): string {
  return `label:${formatLabelForQuery(TARGET_LABEL_NAME)}`;
}

export function sendGmailFilter(): void {
  if (!port || !cachedLabels) return;
  if (!findTargetLabel()) return;
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

function groupBySubject(records: RemindersCacheRecord[]): ReminderGroup[] {
  const map = new Map<string, ReminderGroup>();
  for (const r of records) {
    const subject = r.subject || "(no subject)";
    const existing = map.get(subject);
    if (existing) {
      existing.count++;
      existing.threadId = null;
      if (r.date > existing.latestDate) existing.latestDate = r.date;
    } else {
      map.set(subject, { subject, count: 1, latestDate: r.date, threadId: r.threadId });
    }
  }
  return [...map.values()];
}

function renderEmptyState(message: string): void {
  showContent(`<div class="status">${escapeHtml(message)}</div>`);
}

function renderErrorState(message: string, hint: ErrorHint | null = null): void {
  showContent(buildErrorHtml(message, hint));
}

function renderProgress(done: number, total: number): void {
  const el = document.getElementById("reminders-loading");
  if (el) el.textContent = `Loading ${done} / ${total}…`;
}

function renderRecords(): void {
  setCount(currentRecords.length);
  if (currentRecords.length === 0) {
    showContent('<div class="status">No emails in this label.</div>');
    return;
  }
  const groups = groupBySubject(currentRecords);
  groups.sort((a, b) => b.latestDate - a.latestDate);
  const rows = groups.map((g) => {
    const display = g.count > 1 ? `${g.subject} (+${g.count - 1})` : g.subject;
    const idAttr = g.threadId !== null ? ` data-msg-id="${escapeHtml(g.threadId)}"` : "";
    const matchAttr = g.threadId === null ? ` data-match-hash="${escapeHtml(buildGroupMatchHash(g.subject))}"` : "";
    const actions = `<span class="row-actions"><button class="row-action-btn" data-action="archive" data-subject="${escapeHtml(g.subject)}" title="Archive (remove pending)">${ICON_ARCHIVE}</button><button class="row-action-btn" data-action="delete" data-subject="${escapeHtml(g.subject)}" title="Move to Trash">${ICON_TRASH}</button></span>`;
    return `<div class="summary-row reminders-row" data-subject="${escapeHtml(g.subject)}"${idAttr}${matchAttr}><span class="summary-subject"><span class="subject-text">${escapeHtml(display)}</span>${actions}</span><span class="summary-date">${escapeHtml(formatDate(g.latestDate))}</span></div>`;
  }).join("");
  showContent(`<div class="summary-list reminders">${rows}</div>`);
  const pane = document.getElementById(PANE_ID);
  if (!pane) return;
  pane.querySelectorAll<HTMLElement>(".summary-row").forEach((row) => {
    row.addEventListener("click", () => {
      const messageId = row.dataset.msgId;
      if (messageId) {
        activeRowKey = messageId;
        updateActiveRow();
        openUrl(buildMessageUrl(messageId));
        return;
      }
      const subject = row.dataset.subject;
      const matchHash = row.dataset.matchHash;
      if (subject !== undefined && matchHash !== undefined) {
        activeRowKey = matchHash;
        updateActiveRow();
        openUrl(buildGroupSearchUrl(subject));
      }
    });
  });
  pane.querySelectorAll<HTMLButtonElement>(".row-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const subject = btn.dataset.subject;
      const action = btn.dataset.action;
      if (subject === undefined) return;
      if (action === "archive") void handleArchive(subject);
      else if (action === "delete") void handleDelete(subject);
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

async function handleArchive(subject: string): Promise<void> {
  if (!remindLabelId) return;
  const remindId = remindLabelId;
  const affected = currentRecords.filter((r) => r.subject === subject);
  if (affected.length === 0) return;
  const messageIds = affected.map((r) => r.messageId);
  const affectedSet = new Set(messageIds);
  currentRecords = currentRecords.filter((r) => !affectedSet.has(r.messageId));
  renderRecords();
  try {
    await archiveMessages(messageIds, remindId);
  } catch (err) {
    currentRecords = [...currentRecords, ...affected];
    renderRecords();
    showActionError(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await removeFromLabelIndex(remindId, messageIds);
  await deleteSummaryRecords(SUMMARY_REMINDERS_STORE, messageIds);
  sendGmailRefresh();
  pushUndo({
    label: `Archive: ${subject || "(no subject)"}${affected.length > 1 ? ` (${affected.length})` : ""}`,
    undo: async () => {
      try {
        await unarchiveMessages(messageIds, remindId);
      } catch (err) {
        showActionError(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      await addToLabelIndex(remindId, messageIds);
      await putSummaryRecords(SUMMARY_REMINDERS_STORE, affected);
      currentRecords = [...currentRecords, ...affected];
      renderRecords();
      sendGmailRefresh();
    },
  });
}

async function handleDelete(subject: string): Promise<void> {
  const affected = currentRecords.filter((r) => r.subject === subject);
  if (affected.length === 0) return;
  const messageIds = affected.map((r) => r.messageId);
  const affectedSet = new Set(messageIds);
  const remindId = remindLabelId;
  currentRecords = currentRecords.filter((r) => !affectedSet.has(r.messageId));
  renderRecords();
  try {
    await trashMessages(messageIds);
  } catch (err) {
    currentRecords = [...currentRecords, ...affected];
    renderRecords();
    showActionError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (remindId) await removeFromLabelIndex(remindId, messageIds);
  await deleteSummaryRecords(SUMMARY_REMINDERS_STORE, messageIds);
  sendGmailRefresh();
  pushUndo({
    label: `Delete: ${subject || "(no subject)"}${affected.length > 1 ? ` (${affected.length})` : ""}`,
    undo: async () => {
      try {
        await untrashMessages(messageIds);
      } catch (err) {
        showActionError(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (remindId) await addToLabelIndex(remindId, messageIds);
      await putSummaryRecords(SUMMARY_REMINDERS_STORE, affected);
      currentRecords = [...currentRecords, ...affected];
      renderRecords();
      sendGmailRefresh();
    },
  });
}

function openUrl(url: string): void {
  if (!port) return;
  try {
    port.postMessage({ type: "openMessage", url });
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
  const label = findTargetLabel();
  if (!label) {
    lastRenderedLabelKey = null;
    setCount(null);
    renderEmptyState(`No label named "${TARGET_LABEL_NAME}" found in this account.`);
    return;
  }
  remindLabelId = label.id;
  const labelKey = label.id;
  if (lastRenderedLabelKey === labelKey && document.getElementById(PANE_ID)?.querySelector(".summary-list")) {
    return;
  }

  showContent('<div class="status" id="reminders-loading">Loading…</div>');

  const ids = await requestLabelMessageIds(label.id);
  if (generation !== renderGeneration || !isActive) return;
  if (ids.length === 0) {
    currentRecords = [];
    renderRecords();
    return;
  }

  try {
    const cached = await getSummaryRecords<RemindersCacheRecord>(SUMMARY_REMINDERS_STORE, ids);
    if (generation !== renderGeneration || !isActive) return;
    const missingIds = ids.filter((id) => !cached.has(id));

    if (missingIds.length > 0) {
      const fetched = await fetchMessagesMetadata(missingIds, 10, (done, total) => {
        if (generation === renderGeneration && isActive) renderProgress(done, total);
      });
      if (generation !== renderGeneration || !isActive) return;
      const newRecords: RemindersCacheRecord[] = fetched.map((m) => ({ messageId: m.id, threadId: m.threadId, subject: cleanSubject(m.subject), date: m.date }));
      await putSummaryRecords(SUMMARY_REMINDERS_STORE, newRecords);
      for (const r of newRecords) cached.set(r.messageId, r);
    }

    currentRecords = ids.map((id) => cached.get(id)).filter((r): r is RemindersCacheRecord => r !== undefined);
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
  remindLabelId = null;
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
