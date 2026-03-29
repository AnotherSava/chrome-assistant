import type { GmailLabel } from "@core/types.js";

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
