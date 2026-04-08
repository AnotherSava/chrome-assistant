import type { CacheMessage, GmailLabel } from "@core/types.js";
import * as db from "./cache-db.js";
import { fetchLabels, fetchLabelMessageIds, fetchScopedMessageIds } from "./gmail-api.js";

/** System labels always cached */
const BASE_SYSTEM_LABELS = ["INBOX", "SENT"];

export interface CacheProgress {
  phase: "labels" | "scope" | "scope-done" | "complete";
  labelsTotal: number;
  labelsDone: number;
  currentLabel?: string;
}

export interface LabelQueryResult {
  labelId: string;
  count: number;
  coLabelCounts: Record<string, number>;
}

export type ProgressCallback = (progress: CacheProgress) => void;

interface FetchState {
  phase: "labels" | "complete";
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
  /** Resolves once account setup and label fetch are complete — safe to call prioritizeLabel after. */
  private initReady: Promise<void> = Promise.resolve();
  private resolveInitReady: (() => void) | null = null;
  showStarred = false;
  showImportant = false;
  /** Pre-computed label indexes filtered by scope. null = no scope filter active. */
  private scopedLabelIdx: Map<string, string[]> | null = null;
  /** The set of message IDs in the current scope — kept for updating scopedLabelIdx when new labels are prioritized. */
  private scopedIdSet: Set<string> | null = null;
  /** The scope timestamp that scopedLabelIdx was built for — used by getLabelIndex to detect multi-window races where another port's setScopeFilter overwrote the shared state. */
  private activeScopeTimestamp: number | null | undefined = undefined;
  /** Monotonically increasing generation for setScopeFilter — prevents stale in-flight calls from overwriting fresher results. */
  private scopeFilterGen = 0;
  /** Per-timestamp cache of scoped ID sets — enables correct on-the-fly intersection when multiple windows use different scopes and the active scopedLabelIdx was built for a different timestamp. */
  private scopedIdSets = new Map<number, Set<string>>();

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  /** Get the current in-memory label list (used by the service worker to resolve label names). */
  getLabels(): GmailLabel[] {
    return this.labels;
  }

  /** Replace the in-memory label list (e.g. when fresher labels arrive from a fetchLabels call). */
  setLabels(labels: GmailLabel[]): void {
    this.labels = labels;
  }

  /** Update which optional system labels are included in cache queries. */
  updateSystemLabelSettings(showStarred: boolean, showImportant: boolean): void {
    this.showStarred = showStarred;
    this.showImportant = showImportant;
  }

  /** Return the scope timestamp that the current scopedLabelIdx was built for. */
  getActiveScopeTimestamp(): number | null | undefined {
    return this.activeScopeTimestamp;
  }

  /** Clear cached scope state and bump the scope filter generation so any in-flight setScopeFilter calls from before the invalidation bail out. Called by the service worker when the underlying label indexes change (cache complete, backfill, etc.). */
  clearScopeState(): void {
    this.scopedLabelIdx = null;
    this.scopedIdSet = null;
    this.activeScopeTimestamp = undefined;
    this.scopeFilterGen++;
    this.scopedIdSets.clear();
  }

  /** Set scope filter: fetches scoped message IDs via API and pre-computes filtered label indexes. Pass null to clear. Uses a generation counter to prevent stale in-flight calls from overwriting fresher results. */
  async setScopeFilter(scopeTimestamp: number | null): Promise<void> {
    const gen = ++this.scopeFilterGen;
    if (scopeTimestamp === null) {
      this.scopedLabelIdx = null;
      this.scopedIdSet = null;
      this.activeScopeTimestamp = null;
      return;
    }
    // Don't fetch scope while cache is still building — indexes are incomplete.
    // After cache completes, pushUpdatedResults will re-apply the scope.
    if (this.labels.length === 0) return;
    let showedSpinner = false;
    try {
      // Check if we already have scoped IDs for this timestamp
      const cachedSet = this.scopedIdSets.get(scopeTimestamp);
      let scopedSet: Set<string>;
      if (cachedSet) {
        scopedSet = cachedSet;
      } else {
        const dateStr = this.timestampToDateString(scopeTimestamp);
        showedSpinner = true;
        this.emitProgress({ phase: "scope", labelsTotal: 0, labelsDone: 0 });
        let lastReported = 0;
        const scopedIds = await fetchScopedMessageIds(dateStr, (count) => { if (count - lastReported >= 1000) { lastReported = count; this.emitProgress({ phase: "scope", labelsTotal: 0, labelsDone: count }); } });
        scopedSet = new Set(scopedIds);
        // Cache per timestamp for reuse. Evict oldest to prevent unbounded growth.
        const MAX_SCOPED_ID_SETS = 5;
        if (this.scopedIdSets.size >= MAX_SCOPED_ID_SETS && !this.scopedIdSets.has(scopeTimestamp)) {
          const oldestKey = this.scopedIdSets.keys().next().value!;
          this.scopedIdSets.delete(oldestKey);
        }
        this.scopedIdSets.set(scopeTimestamp, scopedSet);
      }
      if (gen !== this.scopeFilterGen) return;

      // Intersect with each known label index
      const scopedMap = new Map<string, string[]>();
      const labels = this.labels;
      for (const label of labels) {
        const fullIndex = await db.getMeta<string[]>(`labelIdx:${label.id}`);
        if (gen !== this.scopeFilterGen) return;
        if (!fullIndex) continue;
        const filtered = fullIndex.filter(id => scopedSet.has(id));
        scopedMap.set(label.id, filtered);
      }
      if (gen !== this.scopeFilterGen) return;
      this.scopedIdSet = scopedSet;
      this.scopedLabelIdx = scopedMap;
      this.activeScopeTimestamp = scopeTimestamp;
    } finally {
      if (showedSpinner) this.emitProgress({ phase: "scope-done", labelsTotal: 0, labelsDone: 0 });
    }
  }

  /** Get label index: returns scoped index when scope is active, or falls back to IndexedDB label index. When expectedScope is provided and doesn't match the active scope (e.g. multi-window race), computes filtered results on the fly from the per-timestamp scoped ID set cache. Falls back to unscoped IndexedDB only if no cached set is available. */
  async getLabelIndex(labelId: string, expectedScope?: number | null): Promise<string[] | undefined> {
    if (this.scopedLabelIdx) {
      if (expectedScope !== undefined && expectedScope !== this.activeScopeTimestamp) {
        return this.computeFromCachedScope(labelId, expectedScope);
      }
      return this.scopedLabelIdx.get(labelId);
    }
    if (expectedScope !== undefined && expectedScope !== null) {
      return this.computeFromCachedScope(labelId, expectedScope);
    }
    return db.getMeta<string[]>(`labelIdx:${labelId}`);
  }

  /** Compute a filtered label index from a per-timestamp cached scoped ID set. Falls back to unscoped IndexedDB if no cached set is available for the given scope. */
  private async computeFromCachedScope(labelId: string, expectedScope: number | null): Promise<string[] | undefined> {
    if (expectedScope !== null) {
      const cachedSet = this.scopedIdSets.get(expectedScope);
      if (cachedSet) {
        const fullIndex = await db.getMeta<string[]>(`labelIdx:${labelId}`);
        return fullIndex ? fullIndex.filter(id => cachedSet.has(id)) : undefined;
      }
    }
    return db.getMeta<string[]>(`labelIdx:${labelId}`);
  }

  abort(): void {
    this.aborted = true;
  }

  /** Returns true if the current fetch has been superseded or aborted. */
  private isStale(generation: number): boolean {
    return this.aborted || generation !== this.fetchGeneration;
  }

  /** Returns a promise that resolves once account setup and label fetch are complete. Safe to call prioritizeLabel after this resolves. */
  whenReady(): Promise<void> {
    return this.initReady;
  }

  /** Create a pending readiness gate. Must be called synchronously before any async work
   *  so that whenReady() callers block until startFetch resolves initReady. */
  resetReady(): void {
    this.initReady = new Promise(resolve => { this.resolveInitReady = resolve; });
  }

  /** Resolve the readiness gate without running startFetch (e.g. when cache is already fresh). */
  resolveReady(): void {
    if (this.resolveInitReady) { this.resolveInitReady(); this.resolveInitReady = null; }
  }

  /** Populate the in-memory labels list without running a full fetch (e.g. after service worker restart with fresh cache). */
  async loadLabels(): Promise<void> {
    this.labels = await fetchLabels();
  }

  /** Start the full cache population: fetch labels then cross-reference messages. */
  async startFetch(accountPath: string): Promise<void> {
    this.aborted = true;
    // Increment generation BEFORE awaiting the old fetch so the old fetch's finally block
    // sees a stale generation and does not resolve the new readiness gate.
    const generation = ++this.fetchGeneration;
    if (this.activeFetch) await this.activeFetch.catch(() => {});
    this.aborted = false;
    this.processedLabels.clear();
    // Reuse the pending readiness gate if resetReady() was already called (e.g. by startCacheIfNeeded),
    // so callers who captured whenReady() before startFetch runs aren't left waiting on an orphaned promise.
    if (!this.resolveInitReady) {
      this.initReady = new Promise(resolve => { this.resolveInitReady = resolve; });
    }
    const fetchPromise = this.runFetch(accountPath, generation);
    this.activeFetch = fetchPromise;
    try {
      await fetchPromise;
    } finally {
      if (this.activeFetch === fetchPromise) this.activeFetch = null;
    }
  }

  private async runFetch(accountPath: string, generation: number): Promise<void> {
    try {
      const storedAccount = await db.getMeta<string>("account");
      if (storedAccount && storedAccount !== accountPath) {
        await db.clearAll();
      }
      await db.setMeta("account", accountPath);

      this.labels = await fetchLabels();
    } finally {
      // Only resolve the readiness gate if this fetch is still the current one;
      // otherwise a newer resetReady() has replaced the resolver and should be
      // resolved by its own fetch to avoid unblocking callers prematurely.
      if (generation === this.fetchGeneration && this.resolveInitReady) { this.resolveInitReady(); this.resolveInitReady = null; }
    }

    const labelsToQuery = this.buildLabelQueryList();
    const labelsTotal = labelsToQuery.length;
    let labelsDone = 0;

    const fetchState = await db.getMeta<FetchState>("fetchState");
    const isIncremental = fetchState?.phase === "complete" && fetchState.lastFetchTimestamp !== null;
    const scopeDate = isIncremental ? this.timestampToDateString(fetchState.lastFetchTimestamp!) : undefined;

    this.emitProgress({ phase: "labels", labelsTotal, labelsDone });
    await db.setMeta("fetchState", { phase: "labels", lastFetchTimestamp: fetchState?.lastFetchTimestamp ?? null });

    for (const label of labelsToQuery) {
      // Wait for any priority label processing to finish before continuing
      if (this.priorityBarrier) await this.priorityBarrier;
      if (this.isStale(generation)) return;
      if (this.processedLabels.has(label.id)) { labelsDone++; this.emitProgress({ phase: "labels", labelsTotal, labelsDone }); continue; }
      // Only use incremental scope if the label index already exists; otherwise do a full fetch to build it
      const existingIndex = isIncremental ? await db.getMeta<string[]>(`labelIdx:${label.id}`) : undefined;
      const labelScopeDate = existingIndex && existingIndex.length > 0 ? scopeDate : undefined;
      const messageIds = await fetchLabelMessageIds(label.id, labelScopeDate);
      await this.crossReferenceLabel(label.id, messageIds);
      this.processedLabels.add(label.id);
      labelsDone++;
      this.emitProgress({ phase: "labels", labelsTotal, labelsDone, currentLabel: label.name });
    }

    if (this.isStale(generation)) return;
    const now = Date.now();
    await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
    this.emitProgress({ phase: "complete", labelsTotal, labelsDone: labelsTotal });
  }


  /** Get own and inclusive counts for all known labels. When a scope filter is active, counts come from the pre-computed scopedLabelIdx. Accepts an optional labels override for when this.labels is empty (e.g. after service worker restart with fresh cache). Pass expectedScope to guard against multi-window races. Snapshots scopedLabelIdx at entry so concurrent setScopeFilter calls from other ports cannot mix scoped/unscoped data within a single result. When the active scope doesn't match expectedScope but a cached scoped ID set exists for that timestamp, computes filtered results on the fly. */
  async getLabelCounts(labelsOverride?: GmailLabel[], expectedScope?: number | null): Promise<Record<string, { own: number; inclusive: number }>> {
    const labels = labelsOverride && labelsOverride.length > 0 ? labelsOverride : this.labels;
    // Snapshot scope state to ensure consistent reads throughout the loop
    const scopeSnapshot = this.scopedLabelIdx;
    const scopeTimestampSnapshot = this.activeScopeTimestamp;
    // Check if a cached scoped ID set is available for on-the-fly filtering (multi-window support)
    const fallbackScopeSet = (expectedScope !== undefined && expectedScope !== null && expectedScope !== scopeTimestampSnapshot) ? this.scopedIdSets.get(expectedScope) ?? null : null;
    const useScope = (scopeSnapshot !== null && (expectedScope === undefined || expectedScope === scopeTimestampSnapshot)) || fallbackScopeSet !== null;

    const getIndex = async (labelId: string): Promise<string[] | undefined> => {
      if (scopeSnapshot && (expectedScope === undefined || expectedScope === scopeTimestampSnapshot)) {
        return scopeSnapshot.get(labelId);
      }
      if (fallbackScopeSet) {
        const fullIndex = await db.getMeta<string[]>(`labelIdx:${labelId}`);
        return fullIndex ? fullIndex.filter(id => fallbackScopeSet.has(id)) : undefined;
      }
      return db.getMeta<string[]>(`labelIdx:${labelId}`);
    };

    // Build own counts from label indexes
    const ownCounts: Record<string, number> = {};
    for (const label of labels) {
      const msgIds = await getIndex(label.id);
      if (msgIds === undefined) continue;
      ownCounts[label.id] = msgIds.length;
    }

    const result: Record<string, { own: number; inclusive: number }> = {};

    for (const label of labels) {
      if (!(label.id in ownCounts)) continue;
      const own = ownCounts[label.id];

      const descendants = labels.filter(l => l.id !== label.id && l.name.startsWith(label.name + "/"));

      if (descendants.length === 0) {
        if (useScope && own === 0) continue;
        result[label.id] = { own, inclusive: own };
        continue;
      }

      // Compute inclusive count: union parent + descendant message IDs, deduplicate
      const allIds = [label.id, ...descendants.map(l => l.id)];
      const seenMsgIds = new Set<string>();

      for (const lid of allIds) {
        const msgIds = await getIndex(lid);
        if (msgIds) {
          for (const id of msgIds) seenMsgIds.add(id);
        }
      }

      const inclusive = seenMsgIds.size;

      if (useScope && own === 0 && inclusive === 0) continue;
      result[label.id] = { own, inclusive };
    }

    return result;
  }

  /** Query the cache for a label's message count and co-occurring labels. Resolves descendants internally via prefix matching when includeChildren is true. Uses scoped label indexes when a scope filter is active. Pass expectedScope to guard against multi-window races where another port may have changed the active scope. Snapshots scope state at entry so concurrent setScopeFilter calls cannot mix data within a single result. When the active scope doesn't match expectedScope but a cached scoped ID set exists for that timestamp, computes filtered results on the fly. */
  async queryLabel(labelId: string, includeChildren: boolean, expectedScope?: number | null): Promise<LabelQueryResult> {
    const labelIds = this.resolveLabelIds(labelId, includeChildren);
    const seen = new Set<string>();
    const messages: CacheMessage[] = [];
    // Snapshot scope state for consistent reads throughout the method
    const scopeSnapshot = this.scopedLabelIdx;
    const scopeTimestampSnapshot = this.activeScopeTimestamp;
    const scopedIdSetSnapshot = this.scopedIdSet;
    // Check if a cached scoped ID set is available for on-the-fly filtering (multi-window support)
    const fallbackScopeSet = (expectedScope !== undefined && expectedScope !== null && expectedScope !== scopeTimestampSnapshot) ? this.scopedIdSets.get(expectedScope) ?? null : null;

    const getIndex = async (lid: string): Promise<string[] | undefined> => {
      if (scopeSnapshot && (expectedScope === undefined || expectedScope === scopeTimestampSnapshot)) {
        return scopeSnapshot.get(lid);
      }
      if (fallbackScopeSet) {
        const fullIndex = await db.getMeta<string[]>(`labelIdx:${lid}`);
        return fullIndex ? fullIndex.filter(id => fallbackScopeSet.has(id)) : undefined;
      }
      return db.getMeta<string[]>(`labelIdx:${lid}`);
    };

    for (const lid of labelIds) {
      let msgIds = await getIndex(lid);

      // If no index entry or empty index, the label hasn't been cached yet — fetch it now
      if (!msgIds || msgIds.length === 0) {
        await this.prioritizeLabel(lid);
        // After prioritize, update our snapshot if scope is active so getIndex reads the new data
        if (scopeSnapshot && scopedIdSetSnapshot) {
          const fullIndex = await db.getMeta<string[]>(`labelIdx:${lid}`);
          if (fullIndex) {
            scopeSnapshot.set(lid, fullIndex.filter(id => scopedIdSetSnapshot.has(id)));
          }
        }
        msgIds = await getIndex(lid);
      }

      if (msgIds) {
        const newIds = msgIds.filter(id => !seen.has(id));
        for (const id of newIds) seen.add(id);
        if (newIds.length > 0) {
          const batch = await db.getMessagesBatch(newIds);
          for (const msg of batch.values()) messages.push(msg);
        }
      }
    }

    const coLabelCounts: Record<string, number> = {};
    for (const msg of messages) {
      for (const lid of msg.labelIds) {
        if (lid !== labelId) coLabelCounts[lid] = (coLabelCounts[lid] ?? 0) + 1;
      }
    }

    return { labelId, count: messages.length, coLabelCounts };
  }

  /** Mark a label as processed — prevents duplicate fetches via prioritizeLabel.
   *  Used by the skip path to register labels whose indexes already exist in IndexedDB. */
  markProcessed(labelId: string): void {
    this.processedLabels.add(labelId);
  }

  /** Pause the main cache loop, process a single label, then resume. */
  async prioritizeLabel(labelId: string): Promise<void> {
    // Skip if this label was already fetched (avoids duplicate API calls when
    // both the skip path and syncSettings race to prioritize the same label).
    if (this.processedLabels.has(labelId)) return;
    // Wait for any in-flight priority operation before starting a new one
    while (this.priorityBarrier) await this.priorityBarrier;
    // Re-check after waiting — the in-flight operation may have processed this label.
    if (this.processedLabels.has(labelId)) return;
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

  /** Resolve a labelId into an array of IDs: just the label itself, or the label + its descendants via prefix matching. */
  private resolveLabelIds(labelId: string, includeChildren: boolean): string[] {
    if (!includeChildren) return [labelId];
    const label = this.labels.find(l => l.id === labelId);
    if (!label) return [labelId];
    const descendants = this.labels.filter(l => l.id !== labelId && l.name.startsWith(label.name + "/"));
    return [labelId, ...descendants.map(l => l.id)];
  }

  private timestampToDateString(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Build the list of labels to query. Sorted alphabetically with sub-labels before parents so inclusive counts are ready when the parent is processed. */
  buildLabelQueryList(): GmailLabel[] {
    const addedIds = new Set<string>();
    const result: GmailLabel[] = [];

    // System labels first — always INBOX/SENT, conditionally STARRED/IMPORTANT
    const systemIds = [...BASE_SYSTEM_LABELS];
    if (this.showStarred) systemIds.push("STARRED");
    if (this.showImportant) systemIds.push("IMPORTANT");
    for (const sysId of systemIds) {
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
          if (!existing.labelIds.includes(labelId)) {
            updates.push({ ...existing, labelIds: [...existing.labelIds, labelId] });
          }
        } else {
          updates.push({ id, labelIds: [labelId] });
        }
      }
      if (updates.length > 0) await db.putMessages(updates);
    }
  }

  private emitProgress(progress: CacheProgress): void {
    if (this.onProgress) this.onProgress(progress);
  }
}
