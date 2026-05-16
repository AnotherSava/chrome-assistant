import { escapeHtml } from "@core/icons.js";
import type { GmailLabel } from "@core/types.js";
import { fetchMessagesFull } from "./gmail-api.js";
import { extractExpiryDate } from "./expiry.js";
import { extractMaxDiscount } from "./discount.js";
import { getSummaryRecords, putSummaryRecords, SUMMARY_DEALS_STORE } from "./cache-db.js";

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
const TARGET_LABEL_NAME = "ads/deal";

let port: chrome.runtime.Port | null = null;
let cachedLabels: GmailLabel[] | null = null;
let accountPath: string = "/mail/u/0/";
let isActive = false;
let renderGeneration = 0;
let lastRenderedLabelId: string | null = null;
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

function findTargetLabel(): GmailLabel | null {
  if (!cachedLabels) return null;
  const lower = TARGET_LABEL_NAME.toLowerCase();
  return cachedLabels.find((l) => l.name.toLowerCase() === lower) ?? null;
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

function renderEmptyState(message: string): void {
  showContent(`<div class="status">${escapeHtml(message)}</div>`);
}

function renderProgress(done: number, total: number): void {
  const el = document.getElementById("deals-loading");
  if (el) el.textContent = `Loading ${done} / ${total}…`;
}

function renderRecords(records: DealsCacheRecord[]): void {
  const sorted = [...records].sort((a, b) => {
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
    return `<div class="summary-row deals-row" data-msg-id="${escapeHtml(r.threadId)}"><span class="summary-from">${escapeHtml(r.fromName)}</span><span class="summary-subject">${escapeHtml(subject)}</span><span class="summary-discount">${escapeHtml(discountLabel)}</span><span class="summary-date">${escapeHtml(expiryLabel)}</span></div>`;
  }).join("");
  showContent(`<div class="summary-list deals">${rows}</div>`);
  document.querySelectorAll<HTMLElement>(`#${PANE_ID} .summary-row`).forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.msgId;
      if (!id) return;
      activeRowKey = id;
      updateActiveRow();
      openMessage(id);
    });
  });
  updateActiveRow();
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
    renderEmptyState("Loading labels…");
    return;
  }
  const label = findTargetLabel();
  if (!label) {
    lastRenderedLabelId = null;
    setCount(null);
    renderEmptyState(`No label named "${TARGET_LABEL_NAME}" found in this account.`);
    return;
  }
  if (lastRenderedLabelId === label.id && document.getElementById(PANE_ID)?.querySelector(".summary-list")) {
    return;
  }

  showContent('<div class="status" id="deals-loading">Loading…</div>');

  const ids = await requestLabelMessageIds(label.id);
  if (generation !== renderGeneration || !isActive) return;
  if (ids.length === 0) {
    renderRecords([]);
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

    const records = ids.map((id) => cached.get(id)).filter((r): r is DealsCacheRecord => r !== undefined);
    renderRecords(records);
    lastRenderedLabelId = label.id;
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
  lastRenderedLabelId = null;
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
