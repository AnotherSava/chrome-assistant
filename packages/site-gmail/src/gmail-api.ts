import type { GmailLabel } from "@core/types.js";
export type { GmailLabel };

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function getAuthToken(): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive: true });
  if (!result.token) throw new Error("Failed to get auth token");
  return result.token;
}

let refreshPromise: Promise<string> | null = null;

async function refreshToken(staleToken: string): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      await chrome.identity.removeCachedAuthToken({ token: staleToken });
      return getAuthToken();
    })();
    refreshPromise.finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function gmailFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GMAIL_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    const newToken = await refreshToken(token);
    const retry = await fetch(`${GMAIL_BASE}${path}`, { headers: { Authorization: `Bearer ${newToken}` } });
    if (!retry.ok) throw new Error(`Gmail API ${retry.status}: ${retry.statusText}`);
    return retry.json() as Promise<T>;
  }
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function gmailPost(path: string, body: unknown): Promise<void> {
  const token = await getAuthToken();
  const init: RequestInit = { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let response = await fetch(`${GMAIL_BASE}${path}`, init);
  if (response.status === 401) {
    const newToken = await refreshToken(token);
    const retryInit: RequestInit = { ...init, headers: { Authorization: `Bearer ${newToken}`, "Content-Type": "application/json" } };
    response = await fetch(`${GMAIL_BASE}${path}`, retryInit);
  }
  if (!response.ok) throw new Error(`Gmail API ${response.status}: ${response.statusText}`);
}


interface LabelsResponse {
  labels?: GmailLabel[];
}

export async function fetchLabels(): Promise<GmailLabel[]> {
  const token = await getAuthToken();
  const data = await gmailFetch<LabelsResponse>("/labels", token);
  return data.labels ?? [];
}

interface MessagesListResponse {
  messages?: { id: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const SYSTEM_LABEL_IN_MAP: Record<string, string> = { INBOX: "inbox", SENT: "sent", STARRED: "starred", IMPORTANT: "important" };

export function buildSearchQuery(labelName: string | string[] | null, scope: string | null, beforeDate?: string | null): string {
  const parts: string[] = [];
  if (labelName) {
    const names = Array.isArray(labelName) ? labelName : [labelName];
    if (names.length === 1) {
      const inClause = SYSTEM_LABEL_IN_MAP[names[0]];
      parts.push(inClause ? `in:${inClause}` : `label:${formatLabelForQuery(names[0])}`);
    } else if (names.length > 1) {
      const formatted = names.map(n => { const inClause = SYSTEM_LABEL_IN_MAP[n]; return inClause ? `in:${inClause}` : `label:${formatLabelForQuery(n)}`; });
      parts.push(`{${formatted.join(" OR ")}}`);
    }
  }
  if (scope) parts.push(`after:${scope}`);
  if (beforeDate) parts.push(`before:${beforeDate}`);
  return parts.join(" ");
}


/** Fetch all message IDs for a label, paginating automatically. Uses labelIds API parameter for reliable filtering (avoids search query syntax issues with system/category labels). */
export async function fetchLabelMessageIds(labelId: string, scopeDate?: string, beforeDate?: string): Promise<string[]> {
  const token = await getAuthToken();
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    let path = `/messages?maxResults=500&labelIds=${encodeURIComponent(labelId)}`;
    const qParts: string[] = [];
    if (scopeDate) qParts.push(`after:${scopeDate}`);
    if (beforeDate) qParts.push(`before:${beforeDate}`);
    if (qParts.length > 0) path += `&q=${encodeURIComponent(qParts.join(" "))}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const data = await gmailFetch<MessagesListResponse>(path, token);
    for (const msg of data.messages ?? []) allIds.push(msg.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return allIds;
}

/** Fetch all message IDs matching a scope date (q=after:DATE), paginating automatically. No label filter — returns IDs across all labels. Calls onProgress after each page with the running total. */
export async function fetchScopedMessageIds(scopeDate: string, onProgress?: (count: number) => void): Promise<string[]> {
  const token = await getAuthToken();
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    let path = `/messages?maxResults=500&q=${encodeURIComponent(`after:${scopeDate}`)}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const data = await gmailFetch<MessagesListResponse>(path, token);
    for (const msg of data.messages ?? []) allIds.push(msg.id);
    pageToken = data.nextPageToken ?? undefined;
    if (onProgress) onProgress(allIds.length);
  } while (pageToken);
  return allIds;
}

export interface PageResult {
  ids: string[];
  nextPageToken: string | null;
}

/** Fetch one page of message IDs for a label. Returns IDs and the next page token (null if no more pages). */
export async function fetchLabelMessageIdsPage(labelId: string, pageToken?: string, scopeDate?: string, beforeDate?: string): Promise<PageResult> {
  const token = await getAuthToken();
  const qParts: string[] = [];
  let path: string;
  if (labelId === "NONE") {
    qParts.push("has:nouserlabels");
    path = `/messages?maxResults=500`;
  } else {
    path = `/messages?maxResults=500&labelIds=${encodeURIComponent(labelId)}`;
  }
  if (scopeDate) qParts.push(`after:${scopeDate}`);
  if (beforeDate) qParts.push(`before:${beforeDate}`);
  if (qParts.length > 0) path += `&q=${encodeURIComponent(qParts.join(" "))}`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  const data = await gmailFetch<MessagesListResponse>(path, token);
  return { ids: (data.messages ?? []).map(m => m.id), nextPageToken: data.nextPageToken ?? null };
}

/** Fetch one page of message IDs matching a date range (q=after:DATE [before:DATE]). Returns IDs and the next page token (null if no more pages). */
export async function fetchScopedMessageIdsPage(scopeDate: string, pageToken?: string, beforeDate?: string): Promise<PageResult> {
  const token = await getAuthToken();
  let q = `after:${scopeDate}`;
  if (beforeDate) q += ` before:${beforeDate}`;
  let path = `/messages?maxResults=500&q=${encodeURIComponent(q)}`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  const data = await gmailFetch<MessagesListResponse>(path, token);
  return { ids: (data.messages ?? []).map(m => m.id), nextPageToken: data.nextPageToken ?? null };
}

/** Format a label name for use in a Gmail search query. */
export function formatLabelForQuery(labelName: string): string {
  return `"${labelName.replace(/"/g, "").replace(/[/ ]/g, "-").toLowerCase()}"`;
}

export interface MessageMetadata { id: string; threadId: string; subject: string; from: string; date: number }
export interface MessageFull extends MessageMetadata { body: string }

interface MessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePart[];
  headers?: { name: string; value: string }[];
}

interface MessageGetResponse {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: MessagePart;
}

function parseHeader(headers: { name: string; value: string }[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return "";
}

function decodeBase64Url(data: string): string {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function findPart(part: MessagePart, mimeType: string): MessagePart | null {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style").forEach((el) => el.remove());
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function extractBodyText(payload: MessagePart | undefined): string {
  if (!payload) return "";
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  return "";
}

async function fetchOneMessageMetadata(id: string, token: string): Promise<MessageMetadata> {
  const path = `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
  const data = await gmailFetch<MessageGetResponse>(path, token);
  return { id: data.id, threadId: data.threadId ?? data.id, subject: parseHeader(data.payload?.headers, "Subject"), from: parseHeader(data.payload?.headers, "From"), date: data.internalDate ? parseInt(data.internalDate, 10) : 0 };
}

async function fetchOneMessageFull(id: string, token: string): Promise<MessageFull> {
  const path = `/messages/${encodeURIComponent(id)}?format=full`;
  const data = await gmailFetch<MessageGetResponse>(path, token);
  return { id: data.id, threadId: data.threadId ?? data.id, subject: parseHeader(data.payload?.headers, "Subject"), from: parseHeader(data.payload?.headers, "From"), date: data.internalDate ? parseInt(data.internalDate, 10) : 0, body: extractBodyText(data.payload) };
}

async function fetchMessagesConcurrent<T>(ids: string[], concurrency: number, fetchOne: (id: string, token: string) => Promise<T>, onProgress?: (done: number, total: number) => void): Promise<T[]> {
  if (ids.length === 0) return [];
  const token = await getAuthToken();
  const results: T[] = new Array(ids.length);
  let nextIndex = 0;
  let done = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, ids.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= ids.length) return;
        results[i] = await fetchOne(ids[i], token);
        done++;
        if (onProgress) onProgress(done, ids.length);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/** Fetch metadata (subject, from, date) for many messages. */
export async function fetchMessagesMetadata(ids: string[], concurrency: number = 10, onProgress?: (done: number, total: number) => void): Promise<MessageMetadata[]> {
  return fetchMessagesConcurrent(ids, concurrency, fetchOneMessageMetadata, onProgress);
}

/** Fetch full messages (metadata + decoded body text) for many messages. */
export async function fetchMessagesFull(ids: string[], concurrency: number = 5, onProgress?: (done: number, total: number) => void): Promise<MessageFull[]> {
  return fetchMessagesConcurrent(ids, concurrency, fetchOneMessageFull, onProgress);
}

/** Batch-modify labels on a set of messages. Returns 204 on success. */
export async function modifyMessageLabels(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
  if (ids.length === 0) return;
  await gmailPost("/messages/batchModify", { ids, addLabelIds, removeLabelIds });
}

/** Remove a label from messages (e.g. archive = remove "pending"). */
export async function archiveMessages(ids: string[], pendingLabelId: string): Promise<void> {
  await modifyMessageLabels(ids, [], [pendingLabelId]);
}

/** Re-add a label to messages (undo archive). */
export async function unarchiveMessages(ids: string[], pendingLabelId: string): Promise<void> {
  await modifyMessageLabels(ids, [pendingLabelId], []);
}

/** Move messages to Trash (recoverable, 30-day window). */
export async function trashMessages(ids: string[]): Promise<void> {
  await modifyMessageLabels(ids, ["TRASH"], []);
}

/** Restore messages from Trash (undo delete). */
export async function untrashMessages(ids: string[]): Promise<void> {
  await modifyMessageLabels(ids, [], ["TRASH"]);
}

