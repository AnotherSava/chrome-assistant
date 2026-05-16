import { escapeHtml } from "@core/icons.js";
import type { GmailLabel } from "@core/types.js";
import { fetchMessagesMetadata, formatLabelForQuery, type MessageMetadata } from "./gmail-api.js";

interface ReminderGroup { subject: string; count: number; latestDate: number; threadId: string | null }

const PANE_ID = "sub-reminders";
const TARGET_LABEL_NAMES = ["notifications/calendar", "pending"];

let port: chrome.runtime.Port | null = null;
let cachedLabels: GmailLabel[] | null = null;
let accountPath: string = "/mail/u/0/";
let isActive = false;
let renderGeneration = 0;
let lastRenderedLabelKey: string | null = null;
let lastCount: number | null = null;
let countListener: ((count: number | null) => void) | null = null;
let activeRowKey: string | null = null;
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

function findTargetLabels(): GmailLabel[] {
  if (!cachedLabels) return [];
  const wanted = new Set(TARGET_LABEL_NAMES.map(n => n.toLowerCase()));
  return cachedLabels.filter((l) => wanted.has(l.name.toLowerCase()));
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
  const labelClauses = TARGET_LABEL_NAMES.map(n => `label:${formatLabelForQuery(n)}`);
  const subjectClause = `subject:"${subject.replace(/"/g, "")}"`;
  return [...labelClauses, subjectClause].join(" ");
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

function groupBySubject(messages: MessageMetadata[]): ReminderGroup[] {
  const map = new Map<string, ReminderGroup>();
  for (const m of messages) {
    const subject = cleanSubject(m.subject || "(no subject)");
    const existing = map.get(subject);
    if (existing) {
      existing.count++;
      existing.threadId = null;
      if (m.date > existing.latestDate) existing.latestDate = m.date;
    } else {
      map.set(subject, { subject, count: 1, latestDate: m.date, threadId: m.threadId });
    }
  }
  return [...map.values()];
}

function renderEmptyState(message: string): void {
  showContent(`<div class="status">${escapeHtml(message)}</div>`);
}

function renderProgress(done: number, total: number): void {
  const el = document.getElementById("reminders-loading");
  if (el) el.textContent = `Loading ${done} / ${total}…`;
}

function renderEmails(messages: MessageMetadata[]): void {
  setCount(messages.length);
  if (messages.length === 0) {
    showContent('<div class="status">No emails in this label.</div>');
    return;
  }
  const groups = groupBySubject(messages);
  groups.sort((a, b) => b.latestDate - a.latestDate);
  const rows = groups.map((g) => {
    const display = g.count > 1 ? `${g.subject} (+${g.count - 1})` : g.subject;
    const idAttr = g.threadId !== null ? ` data-msg-id="${escapeHtml(g.threadId)}"` : "";
    const matchAttr = g.threadId === null ? ` data-match-hash="${escapeHtml(buildGroupMatchHash(g.subject))}"` : "";
    return `<div class="summary-row reminders-row" data-subject="${escapeHtml(g.subject)}"${idAttr}${matchAttr}><span class="summary-subject">${escapeHtml(display)}</span><span class="summary-date">${escapeHtml(formatDate(g.latestDate))}</span></div>`;
  }).join("");
  showContent(`<div class="summary-list reminders">${rows}</div>`);
  document.querySelectorAll<HTMLElement>(`#${PANE_ID} .summary-row`).forEach((row) => {
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
  updateActiveRow();
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
    renderEmptyState("Loading labels…");
    return;
  }
  const labels = findTargetLabels();
  if (labels.length < TARGET_LABEL_NAMES.length) {
    lastRenderedLabelKey = null;
    setCount(null);
    const present = new Set(labels.map(l => l.name.toLowerCase()));
    const missing = TARGET_LABEL_NAMES.filter(n => !present.has(n.toLowerCase()));
    renderEmptyState(`Missing label${missing.length === 1 ? "" : "s"}: ${missing.map(n => `"${n}"`).join(", ")}.`);
    return;
  }
  const labelKey = labels.map(l => l.id).sort().join(",");
  if (lastRenderedLabelKey === labelKey && document.getElementById(PANE_ID)?.querySelector(".summary-list")) {
    return;
  }

  showContent('<div class="status" id="reminders-loading">Loading…</div>');

  const idLists = await Promise.all(labels.map(l => requestLabelMessageIds(l.id)));
  if (generation !== renderGeneration || !isActive) return;
  let intersection = new Set(idLists[0] ?? []);
  for (let i = 1; i < idLists.length; i++) {
    const next = new Set(idLists[i]);
    intersection = new Set([...intersection].filter(id => next.has(id)));
  }
  const ids = [...intersection];
  if (ids.length === 0) {
    renderEmails([]);
    return;
  }

  try {
    const messages = await fetchMessagesMetadata(ids, 10, (done, total) => {
      if (generation === renderGeneration && isActive) renderProgress(done, total);
    });
    if (generation !== renderGeneration || !isActive) return;
    renderEmails(messages);
    lastRenderedLabelKey = labelKey;
  } catch (err) {
    if (generation !== renderGeneration || !isActive) return;
    renderEmptyState(`Failed to load emails: ${err instanceof Error ? err.message : String(err)}`);
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
}

export function handleMessage(message: { type: string; requestId?: string; ids?: string[] }): boolean {
  if (message.type === "labelMessageIds" && message.requestId !== undefined) {
    const resolver = pendingRequests.get(message.requestId);
    if (resolver) {
      pendingRequests.delete(message.requestId);
      resolver(message.ids ?? []);
      return true;
    }
  }
  return false;
}
