import type { CacheMessage, GmailLabel } from "@core/types.js";
import * as db from "./cache-db.js";
import { fetchLabels, fetchLabelMessageIds, batchFetchDates } from "./gmail-api.js";

/** System labels to query during Phase 1 label fetch */
const SYSTEM_LABELS_TO_QUERY = ["INBOX", "SENT", "IMPORTANT", "STARRED", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_FORUMS", "UNREAD"];

export interface CacheProgress {
  phase: "labels" | "dates" | "complete";
  labelsTotal: number;
  labelsDone: number;
  datesTotal: number;
  datesDone: number;
}

export interface LabelQueryResult {
  labelId: string;
  count: number;
  coLabels: string[];
}

export type ProgressCallback = (progress: CacheProgress) => void;

interface LabelCoverage {
  [labelId: string]: { complete: boolean; scope: number | null };
}

interface FetchState {
  phase: "labels" | "dates" | "complete";
  lastFetchTimestamp: number | null;
}

export class CacheManager {
  private labels: GmailLabel[] = [];
  private onProgress: ProgressCallback | null = null;
  private aborted = false;

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  abort(): void {
    this.aborted = true;
  }

  /** Start the full cache population: Phase 1 (labels) then Phase 2 (dates). */
  async startFetch(accountPath: string): Promise<void> {
    this.aborted = false;

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
      if (this.aborted) return;
      const messageIds = await fetchLabelMessageIds(label.name, scopeDate);
      await this.crossReferenceLabel(label.id, messageIds);
      labelsDone++;
      this.emitProgress({ phase: "labels", labelsTotal, labelsDone, datesTotal: 0, datesDone: 0 });
    }

    const coverage: LabelCoverage = {};
    for (const label of labelsToQuery) {
      coverage[label.id] = { complete: true, scope: null };
    }
    await db.setMeta("labelCoverage", coverage);

    if (this.aborted) return;
    await this.fetchDates(labelsTotal);

    const now = Date.now();
    await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
    this.emitProgress({ phase: "complete", labelsTotal, labelsDone: labelsTotal, datesTotal: 0, datesDone: 0 });
  }

  /** Phase 2: batch-fetch dates for messages that don't have them yet. */
  private async fetchDates(labelsTotal: number): Promise<void> {
    const totalMessages = await db.getMessageCount();
    let datesDone = 0;

    await db.setMeta("fetchState", { phase: "dates", lastFetchTimestamp: null });

    let batch = await db.getMessagesWithoutDates(100);
    const datesTotal = await this.countMessagesWithoutDates();

    this.emitProgress({ phase: "dates", labelsTotal, labelsDone: labelsTotal, datesTotal, datesDone });

    while (batch.length > 0) {
      if (this.aborted) return;
      const ids = batch.map(m => m.id);
      const results = await batchFetchDates(ids);
      const updates: CacheMessage[] = [];
      for (const result of results) {
        const existing = await db.getMessage(result.id);
        if (existing) {
          updates.push({ ...existing, internalDate: result.internalDate });
        }
      }
      if (updates.length > 0) await db.putMessages(updates);
      datesDone += batch.length;
      this.emitProgress({ phase: "dates", labelsTotal, labelsDone: labelsTotal, datesTotal, datesDone });
      batch = await db.getMessagesWithoutDates(100);
    }
  }

  private async countMessagesWithoutDates(): Promise<number> {
    let count = 0;
    let batch = await db.getMessagesWithoutDates(1000);
    while (batch.length > 0) {
      count += batch.length;
      if (batch.length < 1000) break;
      batch = await db.getMessagesWithoutDates(1000);
    }
    // This is an approximation since getMessagesWithoutDates scans from start.
    // For a more accurate count, we'd need a dedicated query. For progress reporting this is fine.
    return count;
  }

  /** Query the cache for a label's message count and co-occurring labels. */
  async queryLabel(labelId: string, location: string | undefined, scopeTimestamp: number | null): Promise<LabelQueryResult> {
    let messages = await db.getMessagesByLabel(labelId);

    const locationLabelId = location === "inbox" ? "INBOX" : location === "sent" ? "SENT" : null;
    if (locationLabelId) {
      messages = messages.filter(m => m.labelIds.includes(locationLabelId));
    }

    if (scopeTimestamp !== null) {
      const allHaveDates = messages.every(m => m.internalDate !== null);
      if (allHaveDates) {
        messages = messages.filter(m => m.internalDate !== null && m.internalDate >= scopeTimestamp);
      } else {
        return this.scopeFallback(labelId, locationLabelId, scopeTimestamp);
      }
    }

    const coLabelSet = new Set<string>();
    for (const msg of messages) {
      for (const lid of msg.labelIds) {
        if (lid !== labelId) coLabelSet.add(lid);
      }
    }

    return { labelId, count: messages.length, coLabels: [...coLabelSet] };
  }

  /** Scope fallback: use API to get scoped message IDs, cross-reference with IndexedDB for co-labels. */
  private async scopeFallback(labelId: string, locationLabelId: string | null, scopeTimestamp: number): Promise<LabelQueryResult> {
    const label = this.labels.find(l => l.id === labelId);
    if (!label) return { labelId, count: 0, coLabels: [] };

    const dateStr = this.timestampToDateString(scopeTimestamp);
    const scopedIds = await fetchLabelMessageIds(label.name, dateStr);
    const scopedIdSet = new Set(scopedIds);

    const coLabelSet = new Set<string>();
    let count = 0;

    for (const msgId of scopedIds) {
      const msg = await db.getMessage(msgId);
      if (msg) {
        if (locationLabelId && !msg.labelIds.includes(locationLabelId)) continue;
        count++;
        for (const lid of msg.labelIds) {
          if (lid !== labelId) coLabelSet.add(lid);
        }
      } else {
        count++;
      }
    }

    return { labelId, count, coLabels: [...coLabelSet] };
  }

  private timestampToDateString(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Build the list of labels to query, combining system labels with user labels. */
  private buildLabelQueryList(): GmailLabel[] {
    const result: GmailLabel[] = [];
    const addedIds = new Set<string>();

    for (const sysId of SYSTEM_LABELS_TO_QUERY) {
      const label = this.labels.find(l => l.id === sysId);
      if (label && !addedIds.has(label.id)) {
        result.push(label);
        addedIds.add(label.id);
      }
    }

    for (const label of this.labels) {
      if (label.type === "user" && !addedIds.has(label.id)) {
        result.push(label);
        addedIds.add(label.id);
      }
    }

    return result;
  }

  /** Cross-reference: for each message ID from a label query, add the label to its record. */
  private async crossReferenceLabel(labelId: string, messageIds: string[]): Promise<void> {
    const batchSize = 500;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      const chunk = messageIds.slice(i, i + batchSize);
      const updates: CacheMessage[] = [];
      for (const id of chunk) {
        const existing = await db.getMessage(id);
        if (existing) {
          if (!existing.labelIds.includes(labelId)) {
            updates.push({ ...existing, labelIds: [...existing.labelIds, labelId] });
          }
        } else {
          updates.push({ id, internalDate: null, labelIds: [labelId] });
        }
      }
      if (updates.length > 0) await db.putMessages(updates);
    }
  }

  private emitProgress(progress: CacheProgress): void {
    if (this.onProgress) this.onProgress(progress);
  }
}
