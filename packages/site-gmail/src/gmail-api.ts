import type { GmailLabel } from "@core/types.js";
export type { GmailLabel };

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const BATCH_BASE = "https://www.googleapis.com/batch/gmail/v1";

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

export async function parallelMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/** Fetch all message IDs for a label, paginating automatically. Uses labelIds API parameter for reliable filtering (avoids search query syntax issues with system/category labels). */
export async function fetchLabelMessageIds(labelId: string, scopeDate?: string): Promise<string[]> {
  const token = await getAuthToken();
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    let path = `/messages?maxResults=500&labelIds=${encodeURIComponent(labelId)}`;
    if (scopeDate) path += `&q=${encodeURIComponent(`after:${scopeDate}`)}`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    const data = await gmailFetch<MessagesListResponse>(path, token);
    for (const msg of data.messages ?? []) allIds.push(msg.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return allIds;
}

/** Format a label name for use in a Gmail search query. */
export function formatLabelForQuery(labelName: string): string {
  return `"${labelName.replace(/"/g, "").replace(/[/ ]/g, "-").toLowerCase()}"`;
}

/** Build a multipart/mixed batch request body for Gmail batch API. */
export function buildBatchRequestBody(messageIds: string[], boundary: string): string {
  const parts = messageIds.map((id, index) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <msg${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=minimal&fields=id,internalDate\r\n\r\n`);
  return parts.join("") + `--${boundary}--`;
}

/** Parse a multipart/mixed batch response into individual JSON responses. */
export function parseBatchResponse(responseText: string, contentType: string): { id: string; internalDate: number }[] {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error("No boundary in batch response Content-Type");
  const boundary = boundaryMatch[1].trim();
  const parts = responseText.split(`--${boundary}`).filter(part => part.trim() !== "" && part.trim() !== "--");
  const results: { id: string; internalDate: number }[] = [];
  for (const part of parts) {
    const jsonMatch = part.match(/\{[^{}]*"id"\s*:\s*"[^"]+[^{}]*\}/);
    if (!jsonMatch) continue;
    try {
      const json = JSON.parse(jsonMatch[0]) as { id?: string; internalDate?: string };
      if (json.id) results.push({ id: json.id, internalDate: Number(json.internalDate ?? 0) });
    } catch { /* skip unparseable parts */ }
  }
  return results;
}

export interface BatchDateResult {
  id: string;
  internalDate: number;
}

/** Batch-fetch internalDate for up to 100 messages via Gmail batch API. */
export async function batchFetchDates(messageIds: string[]): Promise<BatchDateResult[]> {
  if (messageIds.length === 0) return [];
  if (messageIds.length > 100) throw new Error("Batch API supports max 100 messages per call");
  const token = await getAuthToken();
  const boundary = `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body = buildBatchRequestBody(messageIds, boundary);
  const response = await fetch(BATCH_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (response.status === 401) {
    const newToken = await refreshToken(token);
    const retry = await fetch(BATCH_BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${newToken}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
      body,
    });
    if (!retry.ok) throw new Error(`Gmail batch API ${retry.status}: ${retry.statusText}`);
    return parseBatchResponse(await retry.text(), retry.headers.get("Content-Type") ?? "");
  }
  if (!response.ok) throw new Error(`Gmail batch API ${response.status}: ${response.statusText}`);
  return parseBatchResponse(await response.text(), response.headers.get("Content-Type") ?? "");
}
