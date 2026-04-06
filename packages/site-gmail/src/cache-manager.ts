import type { CacheMessage, GmailLabel } from "@core/types.js";
import * as db from "./cache-db.js";
import { fetchLabels, fetchLabelMessageIds, batchFetchDates } from "./gmail-api.js";

/** System labels to query during Phase 1 label fetch — only INBOX and SENT are needed for location filtering */
const SYSTEM_LABELS_TO_QUERY = ["INBOX", "SENT"];

export interface CacheProgress {
  phase: "labels" | "dates" | "complete";
  labelsTotal: number;
  labelsDone: number;
  datesTotal: number;
  datesDone: number;
  currentLabel?: string;
}

export interface LabelQueryResult {
  labelId: string;
  count: number;
  coLabelCounts: Record<string, number>;
}

export type ProgressCallback = (progress: CacheProgress) => void;

interface FetchState {
  phase: "labels" | "dates" | "complete";
  lastFetchTimestamp: number | null;
}

export class CacheManager {
  private labels: GmailLabel[] = [];
  private onProgress: ProgressCallback | null = null;
  private aborted = false;
  private fetchGeneration = 0;
  private activeFetch: Promise<void> | null = null;
  /** Labels already processed (by priority or main loop) — skipped by main loop. */
  private processedLabels = new Set<string>();
  /** Resolves when a priority label finishes; main loop awaits this between iterations. */
  private priorityBarrier: Promise<void> | null = null;
  private priorityResolve: (() => void) | null = null;

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  abort(): void {
    this.aborted = true;
  }

  /** Returns true if the current fetch has been superseded or aborted. */
  private isStale(generation: number): boolean {
    return this.aborted || generation !== this.fetchGeneration;
  }

  /** Start the full cache population: Phase 1 (labels) then Phase 2 (dates). */
  async startFetch(accountPath: string): Promise<void> {
    this.aborted = true;
    if (this.activeFetch) await this.activeFetch.catch(() => {});
    this.aborted = false;
    this.processedLabels.clear();
    const generation = ++this.fetchGeneration;
    const fetchPromise = this.runFetch(accountPath, generation);
    this.activeFetch = fetchPromise;
    try {
      await fetchPromise;
    } finally {
      if (this.activeFetch === fetchPromise) this.activeFetch = null;
    }
  }

  private async runFetch(accountPath: string, generation: number): Promise<void> {
    const storedAccount = await db.getMeta<string>("account");
    if (storedAccount && storedAccount !== accountPath) {
      await db.clearAll();
    }
    await db.setMeta("account", accountPath);

    this.labels = await fetchLabels();

    const labelsToQuery = this.buildLabelQueryList();
    const labelsTotal = labelsToQuery.length;
    let labelsDone = 0;

    const fetchState = await db.getMeta<FetchState>("fetchState");
    const isIncremental = fetchState?.phase === "complete" && fetchState.lastFetchTimestamp !== null;
    const scopeDate = isIncremental ? this.timestampToDateString(fetchState.lastFetchTimestamp!) : undefined;

    this.emitProgress({ phase: "labels", labelsTotal, labelsDone, datesTotal: 0, datesDone: 0 });
    await db.setMeta("fetchState", { phase: "labels", lastFetchTimestamp: fetchState?.lastFetchTimestamp ?? null });

    for (const label of labelsToQuery) {
      // Wait for any priority label processing to finish before continuing
      if (this.priorityBarrier) await this.priorityBarrier;
      if (this.isStale(generation)) return;
      if (this.processedLabels.has(label.id)) { labelsDone++; this.emitProgress({ phase: "labels", labelsTotal, labelsDone, datesTotal: 0, datesDone: 0 }); continue; }
      // Only use incremental scope if the label index already exists; otherwise do a full fetch to build it
      const existingIndex = isIncremental ? await db.getMeta<string[]>(`labelIdx:${label.id}`) : undefined;
      const labelScopeDate = existingIndex && existingIndex.length > 0 ? scopeDate : undefined;
      const messageIds = await fetchLabelMessageIds(label.id, labelScopeDate);
      await this.crossReferenceLabel(label.id, messageIds);
      this.processedLabels.add(label.id);
      labelsDone++;
      this.emitProgress({ phase: "labels", labelsTotal, labelsDone, datesTotal: 0, datesDone: 0, currentLabel: label.name });
    }

    if (this.isStale(generation)) return;
    await this.fetchDates(labelsTotal, generation);

    if (this.isStale(generation)) return;
    const now = Date.now();
    await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
    this.emitProgress({ phase: "complete", labelsTotal, labelsDone: labelsTotal, datesTotal: 0, datesDone: 0 });
  }

  /** Phase 2: batch-fetch dates for messages that don't have them yet. */
  private async fetchDates(labelsTotal: number, generation: number): Promise<void> {
    let datesDone = 0;

    const prevState = await db.getMeta<FetchState>("fetchState");
    await db.setMeta("fetchState", { phase: "dates", lastFetchTimestamp: prevState?.lastFetchTimestamp ?? null });

    let batch = await db.getMessagesWithoutDates(100);
    const datesTotal = await db.countMessagesWithoutDates();

    this.emitProgress({ phase: "dates", labelsTotal, labelsDone: labelsTotal, datesTotal, datesDone });

    while (batch.length > 0) {
      if (this.isStale(generation)) return;
      const ids = batch.map(m => m.id);
      const results = await batchFetchDates(ids);
      const batchMap = new Map(batch.map(m => [m.id, m]));
      const returnedIds = new Set(results.map(r => r.id));
      const updates: CacheMessage[] = [];
      for (const result of results) {
        const existing = batchMap.get(result.id);
        if (existing) {
          updates.push({ ...existing, internalDate: result.internalDate, status: "fetched" });
        }
      }
      // Mark messages not returned by the batch API as inaccessible to prevent re-fetching
      for (const msg of batch) {
        if (!returnedIds.has(msg.id)) {
          updates.push({ ...msg, status: "inaccessible" });
        }
      }
      if (updates.length > 0) await db.putMessages(updates);
      datesDone += batch.length;
      this.emitProgress({ phase: "dates", labelsTotal, labelsDone: labelsTotal, datesTotal, datesDone });
      batch = await db.getMessagesWithoutDates(100);
    }
  }


  /** Get own and inclusive counts for all known labels, filtered by location/scope. Accepts an optional labels override for when this.labels is empty (e.g. after service worker restart with fresh cache). */
  async getLabelCounts(location: string | undefined, scopeTimestamp: number | null, labelsOverride?: GmailLabel[]): Promise<Record<string, { own: number; inclusive: number }>> {
    const labels = labelsOverride && labelsOverride.length > 0 ? labelsOverride : this.labels;
    const allLabelIds = labels.map(l => l.id);
    const ownCounts = await db.getFilteredLabelCounts(allLabelIds, location, scopeTimestamp);

    const result: Record<string, { own: number; inclusive: number }> = {};

    for (const label of labels) {
      // Skip labels not yet in the cache — no count is better than a wrong (0)
      if (!(label.id in ownCounts)) continue;
      const own = ownCounts[label.id];

      // Find descendants via prefix matching (e.g. "Work/Projects" is a child of "Work")
      const descendants = labels.filter(l => l.id !== label.id && l.name.startsWith(label.name + "/"));

      if (descendants.length === 0) {
        result[label.id] = { own, inclusive: own };
        continue;
      }

      // Compute inclusive count: union parent + descendant message IDs, deduplicate, then filter
      const descendantIds = descendants.map(l => l.id);
      const allIds = [label.id, ...descendantIds];
      const seenMsgIds = new Set<string>();
      const allMsgIds: string[] = [];

      for (const lid of allIds) {
        const msgIds = await db.getMeta<string[]>(`labelIdx:${lid}`);
        if (msgIds) {
          for (const id of msgIds) {
            if (!seenMsgIds.has(id)) {
              seenMsgIds.add(id);
              allMsgIds.push(id);
            }
          }
        }
      }

      if (allMsgIds.length === 0) {
        result[label.id] = { own, inclusive: 0 };
        continue;
      }

      const locationLabelId = location === "inbox" ? "INBOX" : location === "sent" ? "SENT" : null;
      const msgMap = await db.getMessagesBatch(allMsgIds);
      let inclusive = 0;
      for (const msg of msgMap.values()) {
        if (locationLabelId && !msg.labelIds.includes(locationLabelId)) continue;
        if (scopeTimestamp !== null && (!msg.internalDate || msg.internalDate < scopeTimestamp)) continue;
        inclusive++;
      }

      result[label.id] = { own, inclusive };
    }

    return result;
  }

  /** Query the cache for a label's message count and co-occurring labels. Accepts multiple label IDs and unions their messages. */
  async queryLabel(labelIds: string[], location: string | undefined, scopeTimestamp: number | null): Promise<LabelQueryResult> {
    const primaryId = labelIds[0];
    const seen = new Set<string>();
    let messages: CacheMessage[] = [];

    for (const labelId of labelIds) {
      // Look up message IDs from label index (O(1) meta read) instead of scanning all messages
      let msgIds = await db.getMeta<string[]>(`labelIdx:${labelId}`);

      // If no index entry or empty index, the label hasn't been cached yet — fetch it now
      if (!msgIds || msgIds.length === 0) {
        await this.prioritizeLabel(labelId);
        msgIds = await db.getMeta<string[]>(`labelIdx:${labelId}`);
      }

      if (msgIds) {
        // Filter to IDs not yet seen, then batch-fetch their records
        const newIds = msgIds.filter(id => !seen.has(id));
        for (const id of newIds) seen.add(id);
        if (newIds.length > 0) {
          const batch = await db.getMessagesBatch(newIds);
          for (const msg of batch.values()) messages.push(msg);
        }
      }
    }

    const locationLabelId = location === "inbox" ? "INBOX" : location === "sent" ? "SENT" : null;
    if (locationLabelId) {
      messages = messages.filter(m => m.labelIds.includes(locationLabelId));
    }

    if (scopeTimestamp !== null) {
      const allHaveDates = messages.every(m => !!m.internalDate);
      if (allHaveDates) {
        messages = messages.filter(m => m.internalDate! >= scopeTimestamp);
      } else {
        return this.scopeFallback(labelIds, locationLabelId, scopeTimestamp);
      }
    }

    const coLabelCounts: Record<string, number> = {};
    for (const msg of messages) {
      for (const lid of msg.labelIds) {
        if (lid !== primaryId) coLabelCounts[lid] = (coLabelCounts[lid] ?? 0) + 1;
      }
    }

    return { labelId: primaryId, count: messages.length, coLabelCounts };
  }

  /** Pause the main cache loop, process a single label, then resume. */
  private async prioritizeLabel(labelId: string): Promise<void> {
    this.priorityBarrier = new Promise(resolve => { this.priorityResolve = resolve; });
    try {
      const messageIds = await fetchLabelMessageIds(labelId);
      await this.crossReferenceLabel(labelId, messageIds);
      this.processedLabels.add(labelId);
    } finally {
      const resolve = this.priorityResolve;
      this.priorityBarrier = null;
      this.priorityResolve = null;
      if (resolve) resolve();
    }
  }

  /** Scope fallback: use API to get scoped message IDs for all label IDs, cross-reference with IndexedDB for co-labels. */
  private async scopeFallback(labelIds: string[], locationLabelId: string | null, scopeTimestamp: number): Promise<LabelQueryResult> {
    const primaryId = labelIds[0];
    const dateStr = this.timestampToDateString(scopeTimestamp);
    const seenIds = new Set<string>();
    const allScopedIds: string[] = [];

    for (const labelId of labelIds) {
      const scopedIds = await fetchLabelMessageIds(labelId, dateStr);
      for (const id of scopedIds) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allScopedIds.push(id);
        }
      }
    }

    const msgMap = await db.getMessagesBatch(allScopedIds);
    const coLabelCounts: Record<string, number> = {};
    let count = 0;

    for (const msgId of allScopedIds) {
      const msg = msgMap.get(msgId);
      if (msg) {
        if (locationLabelId && !msg.labelIds.includes(locationLabelId)) continue;
        count++;
        for (const lid of msg.labelIds) {
          if (lid !== primaryId) coLabelCounts[lid] = (coLabelCounts[lid] ?? 0) + 1;
        }
      } else if (!locationLabelId) {
        count++;
      }
    }

    return { labelId: primaryId, count, coLabelCounts };
  }

  private timestampToDateString(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Build the list of labels to query. Sorted alphabetically with sub-labels before parents so inclusive counts are ready when the parent is processed. */
  private buildLabelQueryList(): GmailLabel[] {
    const addedIds = new Set<string>();
    const result: GmailLabel[] = [];

    // System labels first (needed for location filtering)
    for (const sysId of SYSTEM_LABELS_TO_QUERY) {
      const label = this.labels.find(l => l.id === sysId);
      if (label && !addedIds.has(label.id)) {
        result.push(label);
        addedIds.add(label.id);
      }
    }

    // User labels: alphabetically, sub-labels before parents
    const userLabels = this.labels.filter(l => l.type === "user" && !addedIds.has(l.id));
    userLabels.sort((a, b) => {
      if (a.name.startsWith(b.name + "/")) return -1; // a is child of b → a first
      if (b.name.startsWith(a.name + "/")) return 1;  // b is child of a → b first
      return a.name.localeCompare(b.name);
    });
    for (const label of userLabels) {
      result.push(label);
      addedIds.add(label.id);
    }

    return result;
  }

  /** Cross-reference: for each message ID from a label query, add the label to its record and store the label index. */
  private async crossReferenceLabel(labelId: string, messageIds: string[]): Promise<void> {
    // Store label→messageIds index for fast lookup in queryLabel
    const existingIndex = await db.getMeta<string[]>(`labelIdx:${labelId}`);
    if (existingIndex) {
      const merged = new Set(existingIndex);
      for (const id of messageIds) merged.add(id);
      await db.setMeta(`labelIdx:${labelId}`, [...merged]);
    } else {
      await db.setMeta(`labelIdx:${labelId}`, messageIds);
    }
    const batchSize = 500;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const chunk = messageIds.slice(i, i + batchSize);
      const existingMap = await db.getMessagesBatch(chunk);
      const updates: CacheMessage[] = [];
      for (const id of chunk) {
        const existing = existingMap.get(id);
        if (existing) {
          const needsLabel = !existing.labelIds.includes(labelId);
          const needsStatusReset = existing.status === "inaccessible";
          if (needsLabel || needsStatusReset) {
            updates.push({ ...existing, labelIds: needsLabel ? [...existing.labelIds, labelId] : existing.labelIds, status: needsStatusReset ? "pending" : existing.status });
          }
        } else {
          updates.push({ id, internalDate: null, labelIds: [labelId], status: "pending" });
        }
      }
      if (updates.length > 0) await db.putMessages(updates);
    }
  }

  private emitProgress(progress: CacheProgress): void {
    if (this.onProgress) this.onProgress(progress);
  }
}
