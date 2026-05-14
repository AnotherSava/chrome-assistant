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

export interface MessageMetadata { id: string; subject: string; from: string; date: number }

interface MessageGetResponse {
  id: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

function parseHeader(headers: { name: string; value: string }[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return "";
}

/** Fetch metadata (subject, from, date) for one message. */
async function fetchOneMessageMetadata(id: string, token: string): Promise<MessageMetadata> {
  const path = `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
  const data = await gmailFetch<MessageGetResponse>(path, token);
  return { id: data.id, subject: parseHeader(data.payload?.headers, "Subject"), from: parseHeader(data.payload?.headers, "From"), date: data.internalDate ? parseInt(data.internalDate, 10) : 0 };
}

/** Fetch metadata for many messages. Runs up to `concurrency` requests in parallel. Calls onProgress after each completed fetch with running totals. */
export async function fetchMessagesMetadata(ids: string[], concurrency: number = 10, onProgress?: (done: number, total: number) => void): Promise<MessageMetadata[]> {
  if (ids.length === 0) return [];
  const token = await getAuthToken();
  const results: MessageMetadata[] = new Array(ids.length);
  let nextIndex = 0;
  let done = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, ids.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= ids.length) return;
        results[i] = await fetchOneMessageMetadata(ids[i], token);
        done++;
        if (onProgress) onProgress(done, ids.length);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

