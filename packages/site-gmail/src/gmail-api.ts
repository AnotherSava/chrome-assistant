import type { GmailLabel, MessageMeta } from "@core/types.js";
export type { GmailLabel, MessageMeta };

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

interface MessageMinimalResponse {
  id: string;
  labelIds?: string[];
  internalDate?: string;
}

export function buildSearchQuery(location: string | undefined, labelName: string | null, scope: string | null, beforeDate?: string | null): string {
  const parts: string[] = [];
  if (labelName) parts.push(`label:"${labelName.replace(/"/g, "").replace(/[/ ]/g, "-").toLowerCase()}"`);
  const loc = location ?? "inbox";
  if (loc !== "all") parts.push(`in:${loc}`);
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

export interface FetchMessagePageResult {
  messages: MessageMeta[];
  nextPageToken: string | null;
  totalEstimate: number;
}

export async function fetchMessagePage(query: string, pageToken?: string | null, concurrency: number = 5): Promise<FetchMessagePageResult> {
  const token = await getAuthToken();
  let path = `/messages?maxResults=500&q=${encodeURIComponent(query)}`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  const listData = await gmailFetch<MessagesListResponse>(path, token);
  const messageIds = listData.messages ?? [];
  const totalEstimate = listData.resultSizeEstimate ?? 0;
  const messages = await parallelMap(messageIds, async (msg) => {
    const detail = await gmailFetch<MessageMinimalResponse>(`/messages/${msg.id}?format=minimal`, token);
    return { id: detail.id, labelIds: detail.labelIds ?? [], internalDate: Number(detail.internalDate ?? 0) } satisfies MessageMeta;
  }, concurrency);
  return { messages, nextPageToken: listData.nextPageToken ?? null, totalEstimate };
}
