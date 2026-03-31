import { loadSetting, saveSetting } from "@core/settings.js";
import type { MessageMeta } from "@core/types.js";

// ---------------------------------------------------------------------------
// Persistence keys
// ---------------------------------------------------------------------------

const KEY_CACHE_LABELS = "ca_msg_cache_labels";
const KEY_CACHE_MESSAGES = "ca_msg_cache_messages";
const KEY_CACHE_OLDEST = "ca_msg_cache_oldest";
const KEY_CACHE_BROAD_OLDEST = "ca_msg_cache_broad_oldest";
const KEY_CACHE_COMPLETE = "ca_msg_cache_complete";
const KEY_CACHE_LABEL_OLDEST = "ca_msg_cache_label_oldest";
const KEY_CACHE_NEWEST = "ca_msg_cache_newest";
const KEY_CACHE_IDS = "ca_msg_cache_ids";
const KEY_CACHE_ACCOUNT = "ca_msg_cache_account";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MsgCache {
  /** Index→labelId mapping for compact storage */
  labelIndex: string[];
  /** Compact messages: each entry is [internalDate, ...labelIndices] */
  messages: number[][];
  /** Oldest message timestamp across all messages (epoch ms), or null if empty */
  oldest: number | null;
  /** Oldest message timestamp from the broad build only (epoch ms), or null if empty.
   *  Targeted fetches do not update this — used for backfill boundary. */
  broadOldest: number | null;
  /** Whether the broad build has completed (all messages fetched) */
  complete: boolean;
  /** Per-label coverage: labelId → oldest cached timestamp for that label */
  labelOldest: Record<string, number>;
  /** Newest message timestamp in the cache (epoch ms), or null if empty */
  newest: number | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let msgCache: MsgCache = { labelIndex: [], messages: [], oldest: null, broadOldest: null, complete: false, labelOldest: {}, newest: null };
let msgCacheIds: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Label index helpers
// ---------------------------------------------------------------------------

function getLabelIdx(labelId: string): number {
  let idx = msgCache.labelIndex.indexOf(labelId);
  if (idx === -1) {
    idx = msgCache.labelIndex.length;
    msgCache.labelIndex.push(labelId);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getMsgCache(): MsgCache {
  return msgCache;
}

export function loadMsgCache(accountPath?: string): void {
  // If the persisted cache belongs to a different account, discard it
  const storedAccount = loadSetting<string | null>(KEY_CACHE_ACCOUNT, null);
  console.log("[cache] loadMsgCache: accountPath=", accountPath, "storedAccount=", storedAccount);
  if (accountPath !== undefined && storedAccount !== null && storedAccount !== accountPath) {
    // Persisted cache belongs to a different account — discard it
    console.log("[cache] account mismatch, resetting");
    resetMsgCache();
    saveMsgCache(accountPath);
    return;
  }
  if (accountPath !== undefined && storedAccount === null) {
    // No stored owner — cache predates account scoping; discard to avoid cross-account contamination
    console.log("[cache] no stored account, resetting");
    resetMsgCache();
    saveMsgCache(accountPath);
    return;
  }
  msgCache.labelIndex = loadSetting<string[]>(KEY_CACHE_LABELS, []);
  msgCache.messages = loadSetting<number[][]>(KEY_CACHE_MESSAGES, []);
  msgCache.oldest = loadSetting<number | null>(KEY_CACHE_OLDEST, null);
  msgCache.broadOldest = loadSetting<number | null>(KEY_CACHE_BROAD_OLDEST, null);
  msgCache.complete = loadSetting<boolean>(KEY_CACHE_COMPLETE, false);
  msgCache.labelOldest = loadSetting<Record<string, number>>(KEY_CACHE_LABEL_OLDEST, {});
  msgCache.newest = loadSetting<number | null>(KEY_CACHE_NEWEST, null);
  // Rebuild dedup set from persisted message IDs
  const persistedIds = loadSetting<string[]>(KEY_CACHE_IDS, []);
  msgCacheIds = new Set(persistedIds);

  // Validate consistency: IDs count must match messages count (guards against partial localStorage writes)
  if (msgCacheIds.size !== msgCache.messages.length) {
    console.warn("[cache] consistency mismatch! ids:", msgCacheIds.size, "msgs:", msgCache.messages.length, "— resetting");
    resetMsgCache();
  }
}

export function saveMsgCache(accountPath?: string): void {
  console.log("[cache] saveMsgCache called, msgs:", msgCache.messages.length, "labels:", msgCache.labelIndex.length, "account:", accountPath);
  saveSetting(KEY_CACHE_LABELS, msgCache.labelIndex);
  saveSetting(KEY_CACHE_MESSAGES, msgCache.messages);
  saveSetting(KEY_CACHE_OLDEST, msgCache.oldest);
  saveSetting(KEY_CACHE_BROAD_OLDEST, msgCache.broadOldest);
  saveSetting(KEY_CACHE_COMPLETE, msgCache.complete);
  saveSetting(KEY_CACHE_LABEL_OLDEST, msgCache.labelOldest);
  saveSetting(KEY_CACHE_NEWEST, msgCache.newest);
  saveSetting(KEY_CACHE_IDS, [...msgCacheIds]);
  if (accountPath !== undefined) saveSetting(KEY_CACHE_ACCOUNT, accountPath);
}

export function mergeMessages(newMessages: MessageMeta[], source: "broad" | "targeted" = "broad"): void {
  for (const msg of newMessages) {
    if (msgCacheIds.has(msg.id)) continue;
    msgCacheIds.add(msg.id);

    const labelIndices = msg.labelIds.map((lid) => getLabelIdx(lid));
    msgCache.messages.push([msg.internalDate, ...labelIndices]);

    // Update overall oldest and newest
    if (msgCache.oldest === null || msg.internalDate < msgCache.oldest) {
      msgCache.oldest = msg.internalDate;
    }
    if (msgCache.newest === null || msg.internalDate > msgCache.newest) {
      msgCache.newest = msg.internalDate;
    }
    // Only broad build updates broadOldest — targeted fetches must not shift the backfill boundary
    if (source === "broad" && (msgCache.broadOldest === null || msg.internalDate < msgCache.broadOldest)) {
      msgCache.broadOldest = msg.internalDate;
    }

    // Update per-label oldest for every label on this message
    for (const lid of msg.labelIds) {
      const prev = msgCache.labelOldest[lid];
      if (prev === undefined || msg.internalDate < prev) {
        msgCache.labelOldest[lid] = msg.internalDate;
      }
    }
  }
}

export function scopeToTimestamp(scopeValue: string): number | null {
  if (scopeValue === "any") return null;
  const now = Date.now();
  const map: Record<string, () => number> = {
    "1w": () => now - 7 * 86400000,
    "2w": () => now - 14 * 86400000,
    "1m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d.getTime(); },
    "2m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 2); return d.getTime(); },
    "6m": () => { const d = new Date(now); d.setMonth(d.getMonth() - 6); return d.getTime(); },
    "1y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d.getTime(); },
    "3y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 3); return d.getTime(); },
    "5y": () => { const d = new Date(now); d.setFullYear(d.getFullYear() - 5); return d.getTime(); },
  };
  const fn = map[scopeValue];
  return fn ? fn() : null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter compact messages by location, scope timestamp, and optional label.
 * location: "inbox" → must have INBOX index; "sent" → SENT index; "all" → no filter.
 * scopeTimestamp: messages must have internalDate >= this value (null = no filter).
 * labelId: if provided, message must also have this label (co-occurring mode).
 */
export function filterMessages(location: string, scopeTimestamp: number | null, labelId: string | null): number[][] {
  const locationLabelId = location === "inbox" ? "INBOX" : location === "sent" ? "SENT" : null;
  const locationIdx = locationLabelId !== null ? msgCache.labelIndex.indexOf(locationLabelId) : -1;
  const labelIdx = labelId !== null ? msgCache.labelIndex.indexOf(labelId) : -1;

  return msgCache.messages.filter((entry) => {
    // Scope filter
    if (scopeTimestamp !== null && entry[0] < scopeTimestamp) return false;
    // Location filter
    if (locationLabelId !== null) {
      if (locationIdx === -1) return false;
      if (!entry.includes(locationIdx, 1)) return false;
    }
    // Label co-occurrence filter
    if (labelId !== null) {
      if (labelIdx === -1) return false;
      if (!entry.includes(labelIdx, 1)) return false;
    }
    return true;
  });
}

/**
 * Derive the set of label IDs that appear on filtered messages.
 * Takes compact number[][] entries and returns a Set of label ID strings.
 */
export function deriveRelevantLabelIds(filtered: number[][]): Set<string> {
  const ids = new Set<string>();
  for (const entry of filtered) {
    for (let i = 1; i < entry.length; i++) {
      const labelId = msgCache.labelIndex[entry[i]];
      if (labelId !== undefined) ids.add(labelId);
    }
  }
  return ids;
}

/**
 * Add parent labels to ensure tree integrity. For any relevant label like "A/B/C",
 * add "A" and "A/B" if they exist in allLabels.
 */
export function addParentChain(relevantIds: Set<string>, allLabels: Array<{ id: string; name: string }>): Set<string> {
  const result = new Set(relevantIds);
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const label of allLabels) {
    nameToId.set(label.name, label.id);
    idToName.set(label.id, label.name);
  }
  for (const id of relevantIds) {
    const name = idToName.get(id);
    if (!name) continue;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parentName = parts.slice(0, i).join("/");
      const parentId = nameToId.get(parentName);
      if (parentId) result.add(parentId);
    }
  }
  return result;
}

/**
 * Check if the cache covers a given query (can filter locally without fetching).
 * No label: cache.complete or scopeTimestamp >= cache.oldest.
 * With label: labelOldest[labelId] <= scopeTimestamp (targeted fetch required).
 *
 * Note: cache.complete is NOT trusted for per-label queries because Gmail's
 * messages.list with q="" silently skips messages that have only user labels
 * and no system labels (INBOX, SENT, CATEGORY_*, etc.). A targeted fetch
 * with an explicit label: query is needed to ensure full coverage.
 */
export function isCacheCovering(labelId: string | null, scopeTimestamp: number | null): boolean {
  if (labelId === null) {
    if (msgCache.complete) return true;
    if (scopeTimestamp !== null && msgCache.oldest !== null && scopeTimestamp >= msgCache.oldest) return true;
    if (scopeTimestamp === null) return false;
    return msgCache.oldest !== null && scopeTimestamp >= msgCache.oldest;
  }
  // Label selected: only trust per-label targeted coverage
  const labelOld = msgCache.labelOldest[labelId];
  if (labelOld === undefined) return false;
  // scopeTimestamp null means "any time" — sentinel value 0 means targeted fetch covered all history
  if (scopeTimestamp === null) return labelOld === 0;
  return labelOld <= scopeTimestamp;
}

/** Clear per-label coverage tracking (e.g. when location changes) */
export function clearLabelOldest(): void {
  msgCache.labelOldest = {};
}

/** Reset cache state (for testing) */
export function resetMsgCache(): void {
  msgCache = { labelIndex: [], messages: [], oldest: null, broadOldest: null, complete: false, labelOldest: {}, newest: null };
  msgCacheIds = new Set();
}
