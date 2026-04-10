import type { GmailLabel } from "@core/types.js";
import * as db from "./cache-db.js";
import { fetchLabels, fetchLabelMessageIds, fetchScopedMessageIds, fetchLabelMessageIdsPage, fetchScopedMessageIdsPage } from "./gmail-api.js";

/** System labels always cached */
const BASE_SYSTEM_LABELS = ["INBOX", "SENT"];

/** Compute expansion tier timestamps using calendar semantics (matching the UI's scopeToTimestamp). Returns timestamps ordered from narrowest to widest scope. */
function expansionTierTimestamps(now: Date): number[] {
  const tier = (fn: (d: Date) => void): number => {
    const d = new Date(now);
    fn(d);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return [
    tier(d => d.setDate(d.getDate() - 7)),          // 1 week
    tier(d => d.setDate(d.getDate() - 14)),         // 2 weeks
    tier(d => d.setMonth(d.getMonth() - 1)),        // 1 month
    tier(d => d.setMonth(d.getMonth() - 2)),        // 2 months
    tier(d => d.setMonth(d.getMonth() - 6)),        // 6 months
    tier(d => d.setFullYear(d.getFullYear() - 1)),  // 1 year
    tier(d => d.setFullYear(d.getFullYear() - 3)),  // 3 years
    tier(d => d.setFullYear(d.getFullYear() - 5)),  // 5 years
  ];
}

export interface CacheProgress {
  phase: "labels" | "scope" | "scope-done" | "expanding" | "complete";
  labelsTotal: number;
  labelsDone: number;
  currentLabel?: string;
  errorText?: string;
}

export interface LabelQueryResult {
  labelId: string;
  count: number;
  coLabelCounts: Record<string, number>;
}

export type ProgressCallback = (progress: CacheProgress) => void;

export interface ResultPush {
  labelId: string | null;
  count: number;
  coLabelCounts: Record<string, number>;
  counts: Record<string, { own: number; inclusive: number }>;
  filterConfig: FilterConfig;
  partial: boolean;
}

export type ResultCallback = (result: ResultPush) => void;

export interface FilterConfig {
  labelId: string | null;
  includeChildren: boolean;
  scopeTimestamp: number | null;
}

export type OrchestratorActionType = "fetch-scope" | "fetch-label" | "refresh-label";

export interface OrchestratorAction {
  type: OrchestratorActionType;
  labelId?: string;
  pageToken?: string;
  scopeDate?: string;
  beforeDate?: string;
  /** The scope timestamp this action targets — used to store results in scopedIdSets under the correct key (needed when fetching a requested scope that differs from filterConfig.scopeTimestamp). */
  scopeTimestamp?: number;
  /** Segment index for parallel scope fetches — each date-range segment gets its own continuation key. */
  segmentId?: number;
}

interface Continuation {
  type: OrchestratorActionType;
  labelId?: string;
  nextPageToken: string;
  scopeDate?: string;
  beforeDate?: string;
}

interface FetchState {
  phase: "labels" | "complete";
  lastFetchTimestamp: number | null;
}

export class CacheManager {
  private labels: GmailLabel[] = [];
  private onProgress: ProgressCallback | null = null;
  private onResult: ResultCallback | null = null;
  /** Generation counter for pushResults — incremented on each call so stale async completions are discarded. */
  private pushGeneration = 0;
  private aborted = false;
  private fetchGeneration = 0;
  private activeFetch: Promise<void> | null = null;
  /** Labels already processed (by priority or main loop) — skipped by main loop. */
  private processedLabels = new Set<string>();
  /** In-memory accumulator for multi-page fetch-label — accumulates message IDs per label, writes to IndexedDB only when the label is complete (all pages fetched). Avoids expensive per-page read+merge+write cycles. */
  private labelIdAccumulator = new Map<string, string[]>();
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
  /** Monotonically increasing generation for gap-fill — prevents stale gap-fills from writing results after a newer scope change. (Still used by legacy startGapFill/runGapFill paths.) */
  private gapFillGen = 0;

  // --- Orchestrator state ---
  /** Current filter configuration set by the service worker. */
  private filterConfig: FilterConfig = { labelId: null, includeChildren: false, scopeTimestamp: null };
  /** Whether the orchestrator loop is running. */
  private orchestratorRunning = false;
  /** Number of parallel API calls the orchestrator may issue per iteration. */
  private orchestratorConcurrency = 10;
  /** In-progress pagination state, keyed by action type + label ID. */
  private continuations = new Map<string, Continuation>();
  /** Wake resolver for the orchestrator's idle sleep. */
  private orchestratorWakeResolve: (() => void) | null = null;
  /** Promise that resolves when the orchestrator loop exits — used by start() to await termination of a previous loop. */
  private loopPromise: Promise<void> | null = null;
  /** Monotonic counter to detect stale start() calls — prevents concurrent loops when start() is called during async setup. */
  private startGeneration = 0;
  /** Per-scope accumulators for multi-page scope fetches — keyed by scope timestamp so concurrent scope fetches don't mix their IDs. */
  private scopeAccumulators = new Map<number, string[]>();
  /** Tracks how many segments are pending per scope — keyed by scope timestamp. When it reaches 0, the scope is complete. */
  private scopeSegmentsPending = new Map<number, number>();
  /** Per-scope start times for logging — keyed by scope timestamp. */
  private scopeStartTimes = new Map<number, number>();
  /** In-memory mirror of cacheDepth from IndexedDB. undefined = not yet determined. */
  private cacheDepthTimestamp: number | null | undefined = undefined;
  /** In-memory mirror of lastFetchTimestamp from fetchState. */
  private lastRefreshTimestamp: number | null = null;
  /** Whether the last emitted progress was "complete" — prevents redundant re-emission on idle wakes. */
  private lastProgressWasComplete = false;
  /** Labels that completed refresh in the current cycle. */
  private refreshProcessedLabels = new Set<string>();
  /** Accumulates all message IDs fetched during the current refresh cycle — used to update cached scoped ID sets. */
  private refreshedIds = new Set<string>();
  /** Additional scope timestamps requested by ports (multi-window) that the orchestrator should fetch even if they differ from the global filterConfig.scopeTimestamp. Entries are removed once the scope is fetched. */
  private requestedScopes = new Set<number>();
  /** Resolve function for the error backoff sleep — called by stop() to interrupt backoff. */
  private errorBackoffResolve: (() => void) | null = null;
  /** Timeout ID for the error backoff timer — cleared by stop() to prevent stale callbacks from nulling a future errorBackoffResolve. */
  private errorBackoffTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Start time of the current orchestrator operation (for logging). */
  private operationStartTime: number | null = null;
  /** Type of the current orchestrator operation (for logging). */
  private operationStartType: string | null = null;
  /** Description of the current orchestrator operation (for logging). */
  private operationDescription: string | null = null;
  /** Staleness threshold for incremental refresh (10 minutes). */
  private static readonly REFRESH_STALE_MS = 10 * 60 * 1000;

  private static formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  /** Split a date range into N segments for parallel fetching. Returns array of { scopeDate, beforeDate } pairs. */
  private splitScopeIntoSegments(fromTimestamp: number, toTimestamp: number, segments: number): { scopeDate: string; beforeDate: string }[] {
    const span = toTimestamp - fromTimestamp;
    const segmentSize = Math.ceil(span / segments);
    const result: { scopeDate: string; beforeDate: string }[] = [];
    for (let i = 0; i < segments; i++) {
      const segStart = fromTimestamp + i * segmentSize;
      const segEnd = Math.min(fromTimestamp + (i + 1) * segmentSize, toTimestamp);
      if (segStart >= toTimestamp) break;
      result.push({ scopeDate: this.timestampToDateString(segStart), beforeDate: this.timestampToDateString(segEnd) });
    }
    return result;
  }

  private static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  private static formatDate(ts: number | null): string {
    if (ts === null) return "all time";
    return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  private logOperationStart(type: string, description: string): void {
    this.operationStartTime = Date.now();
    this.operationStartType = type;
    this.operationDescription = description;
    console.log(`[cache] ${description} — started at ${CacheManager.formatTime(this.operationStartTime)}`);
  }

  private describeOperation(action: OrchestratorAction): string {
    const labels = this.buildLabelQueryList();
    const labelCount = labels.length;
    switch (action.type) {
      case "fetch-scope": {
        const date = action.scopeDate ?? "?";
        return `Fetching scoped message IDs (after ${date})`;
      }
      case "fetch-label": {
        return `Fetching emails per label (${labelCount} labels, all time)`;
      }
      case "refresh-label": {
        const since = action.scopeDate ?? "?";
        return `Refreshing cache (${labelCount} labels, since ${since})`;
      }
    }
  }

  private logOperationEnd(): void {
    if (!this.operationDescription) return;
    const now = Date.now();
    const duration = this.operationStartTime !== null ? CacheManager.formatDuration(now - this.operationStartTime) : "?";
    console.log(`[cache] ${this.operationDescription} — finished at ${CacheManager.formatTime(now)}, took ${duration}`);
    this.operationStartTime = null;
    this.operationStartType = null;
    this.operationDescription = null;
  }

  setProgressCallback(callback: ProgressCallback): void {
    this.onProgress = callback;
  }

  setResultCallback(callback: ResultCallback): void {
    this.onResult = callback;
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
    // Persist so alarm-driven restarts after SW suspension retain these settings
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      chrome.storage.session.set({ showStarred, showImportant });
    }
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
    this.scopedIdSets.clear();
    this.scopeFilterGen++;
    this.gapFillGen++;
  }

  /** Set scope filter: fetches scoped message IDs via API and pre-computes filtered label indexes. Pass null to clear. Uses a generation counter to prevent stale in-flight calls from overwriting fresher results. When the new scope is wider than cacheDepth, triggers a background gap-fill to fetch the missing segment. */
  async setScopeFilter(scopeTimestamp: number | null): Promise<void> {
    const gen = ++this.scopeFilterGen;
    if (scopeTimestamp === null) {
      this.scopedLabelIdx = null;
      this.scopedIdSet = null;
      this.activeScopeTimestamp = null;
      // If cache depth is not null, we have partial coverage — gap-fill to full
      const cacheDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      if (gen !== this.scopeFilterGen) return;
      if (cacheDepth && cacheDepth.timestamp !== null) {
        const beforeDate = this.timestampToDateString(cacheDepth.timestamp);
        this.startGapFill(undefined, beforeDate, null);
      }
      return;
    }
    // Don't fetch scope while cache is still building — indexes are incomplete.
    // After cache completes, pushResults will re-apply the scope.
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
        const MAX_SCOPED_ID_SETS = 16;
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

      // Check if scope is wider than cache depth — trigger gap-fill for missing segment
      const cacheDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      if (gen !== this.scopeFilterGen) return;
      if (cacheDepth && cacheDepth.timestamp !== null && scopeTimestamp < cacheDepth.timestamp) {
        const afterDate = this.timestampToDateString(scopeTimestamp);
        const beforeDate = this.timestampToDateString(cacheDepth.timestamp);
        this.startGapFill(afterDate, beforeDate, scopeTimestamp);
      }
    } finally {
      if (showedSpinner) this.emitProgress({ phase: "scope-done", labelsTotal: 0, labelsDone: 0 });
    }
  }

  /** Start a background gap-fill to expand cache coverage. newDepthTimestamp is the target depth after completion (null = full coverage). */
  private startGapFill(afterDate: string | undefined, beforeDate: string, newDepthTimestamp: number | null): void {
    const gapGen = ++this.gapFillGen;
    this.runGapFill(afterDate, beforeDate, gapGen).then(async () => {
      if (gapGen !== this.gapFillGen) return;
      await db.setMeta("cacheDepth", { timestamp: newDepthTimestamp !== null ? this.normalizeToMidnight(newDepthTimestamp) : null });
      this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
    }).catch((err) => {
      console.warn("Gap-fill failed:", err);
      this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0, errorText: `Gap-fill failed: ${err instanceof Error ? err.message : String(err)}` });
    });
  }

  /** Run gap-fill: fetch missing time segment for each label and merge into indexes. */
  private async runGapFill(afterDate: string | undefined, beforeDate: string, generation: number): Promise<void> {
    const labelsToQuery = this.buildLabelQueryList();
    const labelsTotal = labelsToQuery.length;
    let labelsDone = 0;
    this.emitProgress({ phase: "expanding", labelsTotal, labelsDone });
    for (const label of labelsToQuery) {
      if (generation !== this.gapFillGen) return;
      const messageIds = await fetchLabelMessageIds(label.id, afterDate, beforeDate);
      if (generation !== this.gapFillGen) return;
      await this.crossReferenceLabel(label.id, messageIds);
      if (generation !== this.gapFillGen) return;
      labelsDone++;
      this.emitProgress({ phase: "expanding", labelsTotal, labelsDone, currentLabel: label.name });
    }
  }

  /** Normalize a timestamp to the start of the local day (midnight), matching the day-granular normalization used by the UI's scopeToTimestamp. */
  private normalizeToMidnight(timestamp: number): number {
    const d = new Date(timestamp);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Find the next expansion tier timestamp that is strictly wider (older) than the current depth. Returns null if the widest tier is reached (expand to full coverage). Uses calendar semantics matching the UI's scopeToTimestamp to avoid off-by-one mismatches. */
  private nextExpansionTier(currentDepthTimestamp: number, now: Date): number | null {
    const tiers = expansionTierTimestamps(now);
    // Walk tiers from narrowest to widest; find the first one that's strictly older than currentDepth
    for (const tierTimestamp of tiers) {
      if (tierTimestamp < currentDepthTimestamp) return tierTimestamp;
    }
    // All tiers are within current depth — expand to full coverage
    return null;
  }

  /** Background depth expansion: after cache build/refresh, progressively deepen the cache one tier at a time. Interruptible by user actions (new fetch, scope change). */
  private async startBackgroundExpansion(generation: number): Promise<void> {
    const now = new Date();
    // Signal expansion start so the service worker can re-create its keepalive alarm
    this.emitProgress({ phase: "expanding", labelsTotal: 1, labelsDone: 0 });
    try {
      while (!this.isStale(generation)) {
        const currentDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
        if (this.isStale(generation)) return;
        if (!currentDepth || currentDepth.timestamp === null) {
          this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
          return;
        }

        const nextTier = this.nextExpansionTier(currentDepth.timestamp, now);
        const beforeDate = this.timestampToDateString(currentDepth.timestamp);
        const afterDate = nextTier !== null ? this.timestampToDateString(nextTier) : undefined;
        const gapGen = ++this.gapFillGen;

        await this.runGapFill(afterDate, beforeDate, gapGen);
        if (gapGen !== this.gapFillGen || this.isStale(generation)) return;

        await db.setMeta("cacheDepth", { timestamp: nextTier });
        if (nextTier === null) {
          this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
          return;
        }
        this.emitProgress({ phase: "expanding", labelsTotal: 0, labelsDone: 0 });
      }
    } catch (err) {
      console.warn("Background expansion failed:", err);
      if (!this.isStale(generation)) {
        this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0, errorText: `Expansion failed: ${err instanceof Error ? err.message : String(err)}` });
      }
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

  // --- Orchestrator methods ---

  /** Update the filter configuration and wake the orchestrator if idle. Pushes results immediately if data is already cached unless skipPush is true (used during account switches to avoid emitting stale data). */
  setFilterConfig(config: FilterConfig, skipPush?: boolean): void {
    this.filterConfig = { ...config };
    this.lastProgressWasComplete = false;
    this.wakeOrchestrator();
    // Fire-and-forget push — if data is cached, the callback fires immediately
    if (!skipPush) this.pushResults();
  }

  /** Get the current filter configuration. */
  getFilterConfig(): FilterConfig {
    return this.filterConfig;
  }

  /** Set the in-memory cache depth timestamp. */
  setCacheDepthTimestamp(timestamp: number | null | undefined): void {
    this.cacheDepthTimestamp = timestamp;
  }

  /** Get the in-memory cache depth timestamp. */
  getCacheDepthTimestamp(): number | null | undefined {
    return this.cacheDepthTimestamp;
  }

  /** Set the in-memory last refresh timestamp. */
  setLastRefreshTimestamp(timestamp: number | null): void {
    this.lastRefreshTimestamp = timestamp;
  }

  /** Get the in-memory last refresh timestamp. */
  getLastRefreshTimestamp(): number | null {
    return this.lastRefreshTimestamp;
  }


  /** Set the API concurrency level for the orchestrator. */
  setConcurrency(value: number): void {
    this.orchestratorConcurrency = value;
  }

  /** Wake the orchestrator loop from idle sleep. */
  wakeOrchestrator(): void {
    if (this.orchestratorWakeResolve) {
      const resolve = this.orchestratorWakeResolve;
      this.orchestratorWakeResolve = null;
      resolve();
    }
  }

  /** Check whether a given scope timestamp has been fetched and is available for queries. Returns true when scopeTimestamp is null (no scope needed) or when the scope's ID set is cached. */
  isScopeReady(scopeTimestamp: number | null): boolean {
    if (scopeTimestamp === null) return true;
    return this.scopedIdSets.has(scopeTimestamp);
  }

  /** Request the orchestrator to fetch a scope timestamp (ensures the given scope is fetched, not just the global filterConfig scope). No-op if the scope is already cached. Wakes the orchestrator. */
  requestScopeFetch(scopeTimestamp: number): void {
    if (this.scopedIdSets.has(scopeTimestamp)) return;
    this.requestedScopes.add(scopeTimestamp);
    this.wakeOrchestrator();
  }

  /** Sleep until woken by setFilterConfig() or wakeOrchestrator(). */
  private orchestratorSleep(): Promise<void> {
    return new Promise(resolve => { this.orchestratorWakeResolve = resolve; });
  }

  private continuationKey(type: OrchestratorActionType, labelId?: string): string {
    return `${type}:${labelId ?? ""}`;
  }

  /** Return the next requested scope timestamp that isn't already cached, or null if none. */
  private nextRequestedScope(): number | null {
    for (const ts of this.requestedScopes) {
      if (!this.scopedIdSets.has(ts)) return ts;
    }
    this.requestedScopes.clear();
    return null;
  }

  /** Determine up to N non-conflicting actions based on current filter config and cache state. Pure in-memory — no IndexedDB reads. Returns empty list when idle. */
  decide(concurrency: number = this.orchestratorConcurrency): OrchestratorAction[] {
    if (this.labels.length === 0) return [];

    const actions: OrchestratorAction[] = [];
    const usedLabels = new Set<string>();

    const tryAdd = (action: OrchestratorAction): boolean => {
      if (actions.length >= concurrency) return false;
      if (action.labelId && usedLabels.has(action.labelId)) return false;
      actions.push(action);
      if (action.labelId) usedLabels.add(action.labelId);
      return true;
    };

    // Priority 1: Scoped IDs needed — user has scope active but we don't have the scoped ID set.
    // Split large scope fetches into parallel date-range segments for faster completion.
    const neededScope = this.filterConfig.scopeTimestamp !== null && !this.scopedIdSets.has(this.filterConfig.scopeTimestamp) ? this.filterConfig.scopeTimestamp : this.nextRequestedScope();
    if (neededScope !== null) {
      const scopeKey = neededScope;
      // Check if segments are already in progress (have continuations or pending count)
      if (this.scopeSegmentsPending.has(scopeKey)) {
        // Resume in-progress segments
        for (const [contKey, cont] of this.continuations) {
          if (actions.length >= concurrency) break;
          if (contKey.startsWith(`fetch-scope:${scopeKey}:`)) {
            tryAdd({ type: "fetch-scope", pageToken: cont.nextPageToken as string, scopeDate: cont.scopeDate as string, beforeDate: cont.beforeDate as string | undefined, scopeTimestamp: neededScope, segmentId: parseInt(contKey.split(":")[2]) });
          }
        }
      } else if (!this.scopeAccumulators.has(scopeKey)) {
        // Start new scope fetch — log start time
        const now = Date.now();
        this.scopeStartTimes.set(scopeKey, now);
        console.log(`[cache] Fetching scope ${CacheManager.formatDate(neededScope)} — started at ${CacheManager.formatTime(now)}`);
        const span = now - neededScope;
        const segmentCount = Math.min(concurrency, Math.max(1, Math.ceil(span / (7 * 24 * 60 * 60 * 1000)))); // at least 1 week per segment
        if (segmentCount > 1) {
          const segments = this.splitScopeIntoSegments(neededScope, now, segmentCount);
          this.scopeSegmentsPending.set(scopeKey, segments.length);
          for (let i = 0; i < segments.length; i++) {
            if (actions.length >= concurrency) break;
            tryAdd({ type: "fetch-scope", scopeDate: segments[i].scopeDate, beforeDate: segments[i].beforeDate, scopeTimestamp: neededScope, segmentId: i });
          }
        } else {
          // Short scope — single fetch, no segmentation
          tryAdd({ type: "fetch-scope", scopeDate: this.timestampToDateString(neededScope), scopeTimestamp: neededScope });
        }
      }
    }

    // Priority 2: Selected label missing — user selected a label but it's not cached
    if (this.filterConfig.labelId !== null && !this.processedLabels.has(this.filterConfig.labelId)) {
      const labelId = this.filterConfig.labelId;
      const key = this.continuationKey("fetch-label", labelId);
      const cont = this.continuations.get(key);
      if (cont) {
        tryAdd({ type: "fetch-label", labelId, pageToken: cont.nextPageToken });
      } else {
        tryAdd({ type: "fetch-label", labelId });
      }
    }

    // Priority 3: Initial cache build — labels not yet fully indexed
    const queryList = this.buildLabelQueryList();
    for (const label of queryList) {
      if (actions.length >= concurrency) break;
      if (this.processedLabels.has(label.id)) continue;
      if (usedLabels.has(label.id)) continue;
      const key = this.continuationKey("fetch-label", label.id);
      const cont = this.continuations.get(key);
      if (cont) {
        tryAdd({ type: "fetch-label", labelId: label.id, pageToken: cont.nextPageToken });
      } else {
        tryAdd({ type: "fetch-label", labelId: label.id });
      }
    }

    // Check if initial build is complete — lower priorities only apply after all labels are indexed
    const initialBuildComplete = queryList.every(l => this.processedLabels.has(l.id));
    if (!initialBuildComplete || actions.length > 0) return actions;

    // Priority 4: Background scope expansion — pre-fetch wider scoped ID sets through tiers
    // Only expand when a scope is active and the initial build completed through executeAction
    // (cacheDepthTimestamp !== undefined means the build set it to null on completion)
    if (this.filterConfig.scopeTimestamp !== null && this.cacheDepthTimestamp !== undefined) {
      const tiers = expansionTierTimestamps(new Date());
      for (const tier of tiers) {
        if (actions.length >= concurrency) break;
        if (this.scopedIdSets.has(tier)) continue;
        const scopeDate = this.timestampToDateString(tier);
        const key = this.continuationKey("fetch-scope", String(tier));
        const cont = this.continuations.get(key);
        if (cont) {
          tryAdd({ type: "fetch-scope", pageToken: cont.nextPageToken, scopeDate, scopeTimestamp: tier });
        } else {
          if (!this.scopeStartTimes.has(tier)) {
            this.scopeStartTimes.set(tier, Date.now());
            console.log(`[cache] Fetching scope ${CacheManager.formatDate(tier)} — started at ${CacheManager.formatTime(Date.now())}`);
          }
          tryAdd({ type: "fetch-scope", scopeDate, scopeTimestamp: tier });
        }
      }
      if (actions.length > 0) return actions;
    }

    // Priority 5: Incremental refresh — cache is complete but stale
    if (this.lastRefreshTimestamp !== null && Date.now() - this.lastRefreshTimestamp > CacheManager.REFRESH_STALE_MS) {
      const sinceDate = this.timestampToDateString(this.lastRefreshTimestamp);
      for (const label of queryList) {
        if (actions.length >= concurrency) break;
        if (this.refreshProcessedLabels.has(label.id)) continue;
        if (usedLabels.has(label.id)) continue;
        const key = this.continuationKey("refresh-label", label.id);
        const cont = this.continuations.get(key);
        if (cont) {
          tryAdd({ type: "refresh-label", labelId: label.id, pageToken: cont.nextPageToken, scopeDate: sinceDate });
        } else {
          tryAdd({ type: "refresh-label", labelId: label.id, scopeDate: sinceDate });
        }
      }
    }

    return actions;
  }

  /** Execute a single orchestrator action: call the per-page API, store results, update continuation state. */
  async executeAction(action: OrchestratorAction): Promise<void> {
    const key = action.type === "fetch-scope" ? this.continuationKey("fetch-scope", `${action.scopeTimestamp ?? this.filterConfig.scopeTimestamp}${action.segmentId !== undefined ? `:${action.segmentId}` : ""}`) : this.continuationKey(action.type, action.labelId);

    // Cache the query list for isAllLabelsInSet checks within this action
    const queryList = action.type !== "fetch-scope" ? this.buildLabelQueryList() : undefined;

    switch (action.type) {
      case "fetch-scope": {
        const scopeTimestampForAction = action.scopeTimestamp ?? this.filterConfig.scopeTimestamp;
        const result = await fetchScopedMessageIdsPage(action.scopeDate!, action.pageToken, action.beforeDate);
        const scopeKey = scopeTimestampForAction ?? 0;
        const acc = this.scopeAccumulators.get(scopeKey) ?? [];
        acc.push(...result.ids);
        this.scopeAccumulators.set(scopeKey, acc);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "fetch-scope", nextPageToken: result.nextPageToken, scopeDate: action.scopeDate, beforeDate: action.beforeDate });
        } else {
          this.continuations.delete(key);
          // Check if all segments for this scope are done
          const pending = this.scopeSegmentsPending.get(scopeKey);
          if (pending !== undefined && pending > 1) {
            this.scopeSegmentsPending.set(scopeKey, pending - 1);
          } else {
            // All segments complete (or no segments — single fetch)
            this.scopeSegmentsPending.delete(scopeKey);
            const scopeTimestamp = scopeTimestampForAction;
            if (scopeTimestamp !== null) {
              const scopedSet = new Set(acc);
              const MAX_SCOPED_ID_SETS = 16;
              if (this.scopedIdSets.size >= MAX_SCOPED_ID_SETS && !this.scopedIdSets.has(scopeTimestamp)) {
                const oldestKey = this.scopedIdSets.keys().next().value!;
                this.scopedIdSets.delete(oldestKey);
              }
              this.scopedIdSets.set(scopeTimestamp, scopedSet);
              this.requestedScopes.delete(scopeTimestamp);
            }
            this.scopeAccumulators.delete(scopeKey);
            const scopeStart = this.scopeStartTimes.get(scopeKey);
            this.scopeStartTimes.delete(scopeKey);
            const now = Date.now();
            console.log(`[cache] Fetching scope ${CacheManager.formatDate(scopeTimestampForAction)} — finished at ${CacheManager.formatTime(now)}, took ${scopeStart ? CacheManager.formatDuration(now - scopeStart) : "?"}`);
            // Scope is now available — push results
            this.pushResults(true);
          }
        }
        break;
      }
      case "fetch-label": {
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken);
        // Accumulate IDs in memory — write to IndexedDB only when label is complete
        const acc = this.labelIdAccumulator.get(action.labelId!) ?? [];
        acc.push(...result.ids);
        this.labelIdAccumulator.set(action.labelId!, acc);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "fetch-label", labelId: action.labelId, nextPageToken: result.nextPageToken });
        } else {
          this.continuations.delete(key);
          // Write accumulated IDs to IndexedDB in one operation
          await this.crossReferenceLabel(action.labelId!, acc);
          this.labelIdAccumulator.delete(action.labelId!);
          this.processedLabels.add(action.labelId!);
          // Push results when a label finishes indexing — during the initial build
          // this provides progressive count updates; for the selected label it also
          // updates the co-label detail view.
          if (action.labelId === this.filterConfig.labelId || this.cacheDepthTimestamp === undefined) this.pushResults(true);
          if (this.isAllLabelsInSet(this.processedLabels, queryList)) {
            const now = Date.now();
            this.lastRefreshTimestamp = now;
            await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
            // On initial build completion, set full coverage (null = all time)
            if (this.cacheDepthTimestamp === undefined) {
              this.cacheDepthTimestamp = null;
              await db.setMeta("cacheDepth", { timestamp: null });
            }
            // Signal initial build completion so the service worker pushes results
            this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
            // Push updated results with full cache accuracy
            this.pushResults(true);
            this.logOperationEnd();
          }
        }
        break;
      }
      case "refresh-label": {
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken, action.scopeDate);
        const refreshAcc = this.labelIdAccumulator.get(action.labelId!) ?? [];
        refreshAcc.push(...result.ids);
        this.labelIdAccumulator.set(action.labelId!, refreshAcc);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "refresh-label", labelId: action.labelId, nextPageToken: result.nextPageToken, scopeDate: action.scopeDate });
        } else {
          this.continuations.delete(key);
          await this.crossReferenceLabel(action.labelId!, refreshAcc);
          for (const id of refreshAcc) this.refreshedIds.add(id);
          this.labelIdAccumulator.delete(action.labelId!);
          this.refreshProcessedLabels.add(action.labelId!);
          if (this.isAllLabelsInSet(this.refreshProcessedLabels, queryList)) {
            this.lastRefreshTimestamp = Date.now();
            await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: this.lastRefreshTimestamp });
            this.refreshProcessedLabels.clear();
            // Update cached scoped ID sets with newly fetched message IDs — all refreshed
            // messages are newer than lastRefreshTimestamp, so they fall within every cached scope.
            for (const [, scopedSet] of this.scopedIdSets) {
              for (const id of this.refreshedIds) scopedSet.add(id);
            }
            this.refreshedIds.clear();
            // Invalidate pre-computed scope intersections so they're recomputed from updated data
            this.scopedLabelIdx = null;
            this.scopedIdSet = null;
            this.activeScopeTimestamp = undefined;
            this.scopeFilterGen++;
            this.pushResults(true);
            this.logOperationEnd();
          }
        }
        break;
      }
    }
  }

  /** Check if all labels in the query list are in the given set. Accepts an optional pre-built query list to avoid redundant buildLabelQueryList() calls. */
  private isAllLabelsInSet(set: Set<string>, queryList?: GmailLabel[]): boolean {
    return (queryList ?? this.buildLabelQueryList()).every(l => set.has(l.id));
  }

  /** Start the orchestrator loop. Handles account setup, loads labels and cache state, then loops: decide → execute → repeat. Sleeps when idle, wakes on setFilterConfig() or wakeOrchestrator(). Stops any previous loop before starting. */
  async start(accountPath?: string): Promise<void> {
    const myGeneration = ++this.startGeneration;
    if (this.orchestratorRunning) {
      this.stop();
    }
    // Await termination of the previous loop to prevent concurrent loops
    if (this.loopPromise) {
      await this.loopPromise;
    }
    // Another start() was called while we were awaiting — bail out to prevent concurrent loops
    if (myGeneration !== this.startGeneration) return;
    this.orchestratorRunning = true;
    this.lastProgressWasComplete = false;
    this.resetReady();

    try {
      // Account setup — clear stale data if switching accounts
      if (accountPath) {
        const storedAccount = await db.getMeta<string>("account");
        if (storedAccount && storedAccount !== accountPath) {
          await db.clearAll();
          this.labels = [];
          this.processedLabels.clear();
          this.labelIdAccumulator.clear();
          this.scopedIdSets.clear();
          this.scopedLabelIdx = null;
          this.scopedIdSet = null;
          this.activeScopeTimestamp = undefined;
          this.continuations.clear();
          this.scopeAccumulators.clear();
          this.scopeSegmentsPending.clear();
          this.cacheDepthTimestamp = undefined;
          this.lastRefreshTimestamp = null;
          this.refreshProcessedLabels.clear();
          this.requestedScopes.clear();
        }
        await db.setMeta("account", accountPath);
      }

      // Fetch labels
      if (this.labels.length === 0) {
        this.labels = await fetchLabels();
      }

      // Load in-memory state from IndexedDB
      const cacheDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      if (cacheDepth !== undefined) this.cacheDepthTimestamp = cacheDepth.timestamp;
      const fetchState = await db.getMeta<FetchState>("fetchState");
      if (fetchState) {
        this.lastRefreshTimestamp = fetchState.lastFetchTimestamp;
        // If cache was previously complete, detect which labels are already indexed
        // so decide() skips them (avoids re-fetching everything on service worker restart)
        if (fetchState.phase === "complete") {
          for (const label of this.buildLabelQueryList()) {
            const idx = await db.getMeta<string[]>(`labelIdx:${label.id}`);
            if (idx) this.processedLabels.add(label.id);
          }
        }
      }
    } catch (err) {
      console.warn("Orchestrator start failed:", err);
      this.orchestratorRunning = false;
      this.resolveReady();
      throw err;
    }

    // Bail out if another start() was called during the async setup phase
    if (myGeneration !== this.startGeneration) {
      this.orchestratorRunning = false;
      this.resolveReady();
      return;
    }
    this.resolveReady();

    // Emit initial cache state so sidepanel knows the orchestrator is ready
    if (this.processedLabels.size > 0) {
      this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
      // Push results now that labels are loaded — ensures warm-cache restarts get correct counts
      // even when no user interaction triggers setFilterConfig
      this.pushResults(true);
    }

    const loop = async (): Promise<void> => {
      let errorBackoff = 1000;
      while (this.orchestratorRunning) {
        const actions = this.decide(this.orchestratorConcurrency);
        if (actions.length === 0) {
          if (this.operationStartType !== null && this.operationStartType !== "fetch-scope") {
            this.logOperationEnd();
          }
          this.operationStartType = null;
          this.emitOrchestratorProgress(null);
          await this.orchestratorSleep();
          continue;
        }
        // Log operation boundaries when the action type changes (fetch-scope has its own per-scope logging)
        const actionType = actions[0].type;
        if (actionType !== this.operationStartType) {
          if (this.operationStartType !== null) this.logOperationEnd();
          if (actionType !== "fetch-scope") this.logOperationStart(actionType, this.describeOperation(actions[0]));
          else this.operationStartType = actionType;
        }
        try {
          await Promise.all(actions.map(action => this.executeAction(action)));
          this.emitOrchestratorProgress(actions[actions.length - 1]);
          errorBackoff = 1000; // reset on success
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          console.error(`[cache] Error during ${actions[0].type}: ${errorText}`);
          this.emitProgress({ phase: this.orchestratorProgressPhase(actions[0]), labelsTotal: this.buildLabelQueryList().length, labelsDone: this.processedLabels.size, errorText });
          await new Promise<void>(r => { this.errorBackoffResolve = r; this.errorBackoffTimeout = setTimeout(() => { this.errorBackoffResolve = null; this.errorBackoffTimeout = undefined; r(); }, errorBackoff); });
          errorBackoff = Math.min(errorBackoff * 2, 30_000);
        }
      }
    };
    this.loopPromise = loop();
    await this.loopPromise;
    this.loopPromise = null;
  }

  /** Stop the orchestrator loop. */
  stop(): void {
    this.orchestratorRunning = false;
    // Invalidate any in-flight fire-and-forget pushResults() calls so they don't
    // deliver stale data after an account switch.
    this.pushGeneration++;
    this.wakeOrchestrator();
    if (this.errorBackoffTimeout !== undefined) { clearTimeout(this.errorBackoffTimeout); this.errorBackoffTimeout = undefined; }
    if (this.errorBackoffResolve) { this.errorBackoffResolve(); this.errorBackoffResolve = null; }
  }

  /** Whether the orchestrator loop is currently running. */
  isOrchestratorRunning(): boolean {
    return this.orchestratorRunning;
  }

  abort(): void {
    this.aborted = true;
    this.gapFillGen++;
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

  /** Start the full cache population: fetch labels then cross-reference messages. When scopeTimestamp is set, only fetches messages within that scope for the initial build. */
  async startFetch(accountPath: string, scopeTimestamp?: number | null): Promise<void> {
    this.aborted = true;
    // Cancel any in-flight gap-fill/background-expansion so it doesn't write stale data
    // (e.g. from a previous account) after clearAll() below.
    this.gapFillGen++;
    // Increment generation BEFORE awaiting the old fetch so the old fetch's finally block
    // sees a stale generation and does not resolve the new readiness gate.
    const generation = ++this.fetchGeneration;
    if (this.activeFetch) await this.activeFetch.catch(() => {});
    this.aborted = false;
    this.processedLabels.clear();
    this.labelIdAccumulator.clear();
    // Clear cached scoped ID sets — they become stale after refresh (new messages arrive)
    // and after account switches (different message IDs for the same timestamps).
    // Gap-fill and label prioritization do NOT go through startFetch, so their valid
    // cached sets are preserved.
    this.scopedIdSets.clear();
    // Reuse the pending readiness gate if resetReady() was already called (e.g. by startCacheIfNeeded),
    // so callers who captured whenReady() before startFetch runs aren't left waiting on an orphaned promise.
    if (!this.resolveInitReady) {
      this.initReady = new Promise(resolve => { this.resolveInitReady = resolve; });
    }
    const fetchPromise = this.runFetch(accountPath, generation, scopeTimestamp);
    this.activeFetch = fetchPromise;
    try {
      await fetchPromise;
    } finally {
      if (this.activeFetch === fetchPromise) this.activeFetch = null;
    }
  }

  private async runFetch(accountPath: string, generation: number, scopeTimestamp?: number | null): Promise<void> {
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
    const incrementalScopeDate = isIncremental ? this.timestampToDateString(fetchState.lastFetchTimestamp!) : undefined;
    // For initial (non-incremental) builds, use the provided scopeTimestamp to limit the fetch
    const initialScopeDate = (!isIncremental && scopeTimestamp != null) ? this.timestampToDateString(scopeTimestamp) : undefined;
    // For incremental refreshes with partial depth, new labels (no existing index) should be
    // bounded by cacheDepth rather than fetched from full history — otherwise one new label
    // gets full coverage while the rest of the cache is depth-limited.
    let incrementalNewLabelDate: string | undefined;
    if (isIncremental) {
      const cacheDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      if (this.isStale(generation)) return;
      incrementalNewLabelDate = cacheDepth?.timestamp != null ? this.timestampToDateString(cacheDepth.timestamp) : undefined;
    }

    this.emitProgress({ phase: "labels", labelsTotal, labelsDone });
    await db.setMeta("fetchState", { phase: "labels", lastFetchTimestamp: fetchState?.lastFetchTimestamp ?? null });

    for (const label of labelsToQuery) {
      // Wait for any priority label processing to finish before continuing
      if (this.priorityBarrier) await this.priorityBarrier;
      if (this.isStale(generation)) return;
      if (this.processedLabels.has(label.id)) { labelsDone++; this.emitProgress({ phase: "labels", labelsTotal, labelsDone }); continue; }
      // Only use incremental scope if the label index already exists; otherwise use cache depth boundary
      const existingIndex = isIncremental ? await db.getMeta<string[]>(`labelIdx:${label.id}`) : undefined;
      const labelScopeDate = existingIndex !== undefined ? incrementalScopeDate : (isIncremental ? incrementalNewLabelDate : initialScopeDate);
      const messageIds = await fetchLabelMessageIds(label.id, labelScopeDate);
      await this.crossReferenceLabel(label.id, messageIds);
      if (this.isStale(generation)) return;
      this.processedLabels.add(label.id);
      labelsDone++;
      this.emitProgress({ phase: "labels", labelsTotal, labelsDone, currentLabel: label.name });
    }

    if (this.isStale(generation)) return;
    const now = Date.now();
    await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
    // Store cache depth: how far back in time the label indexes cover.
    // On initial build with scope, depth = scopeTimestamp. Without scope, depth = null (full coverage).
    // On incremental refresh, preserve existing depth (don't regress).
    if (!isIncremental) {
      // Normalize to midnight for consistency with expansion tiers and UI scope timestamps
      const normalizedDepth = scopeTimestamp != null ? this.normalizeToMidnight(scopeTimestamp) : null;
      await db.setMeta("cacheDepth", { timestamp: normalizedDepth });
    }
    this.emitProgress({ phase: "complete", labelsTotal, labelsDone: labelsTotal });

    // After build/refresh, start background depth expansion if we have partial coverage
    if (!this.isStale(generation)) {
      const currentDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      if (currentDepth && currentDepth.timestamp !== null) {
        this.startBackgroundExpansion(generation);
      }
    }
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

    // Build the set of message IDs for the selected label(s)
    const selectedMsgIds = new Set<string>();
    for (const lid of labelIds) {
      let msgIds = await getIndex(lid);

      // If no index entry or empty index, the label hasn't been cached yet.
      // When the orchestrator is running, skip the blocking prioritizeLabel call — the
      // orchestrator's Priority 2 (selected label) will fetch it, and pushResults
      // will deliver results once the label is indexed.
      if (!msgIds || msgIds.length === 0) {
        if (!this.orchestratorRunning) {
          await this.prioritizeLabel(lid);
          if (scopeSnapshot && scopedIdSetSnapshot) {
            const fullIndex = await db.getMeta<string[]>(`labelIdx:${lid}`);
            if (fullIndex) {
              scopeSnapshot.set(lid, fullIndex.filter(id => scopedIdSetSnapshot.has(id)));
            }
          }
          msgIds = await getIndex(lid);
        }
      }

      if (msgIds) {
        for (const id of msgIds) selectedMsgIds.add(id);
      }
    }

    // Compute co-label counts by intersecting each label's index with the selected message IDs
    const coLabelCounts: Record<string, number> = {};
    for (const label of this.labels) {
      if (label.id === labelId) continue;
      const otherIndex = await getIndex(label.id);
      if (!otherIndex) continue;
      let count = 0;
      for (const id of otherIndex) {
        if (selectedMsgIds.has(id)) count++;
      }
      if (count > 0) coLabelCounts[label.id] = count;
    }

    return { labelId, count: selectedMsgIds.size, coLabelCounts };
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
      // Respect cacheDepth so on-demand labels don't fetch beyond the current depth boundary.
      // Fall back to scopeTimestamp during initial build (before depth is established) to avoid fetching entire label history.
      const cacheDepth = await db.getMeta<{ timestamp: number | null }>("cacheDepth");
      const afterDate = cacheDepth?.timestamp != null ? this.timestampToDateString(cacheDepth.timestamp) : (this.filterConfig.scopeTimestamp !== null ? this.timestampToDateString(this.filterConfig.scopeTimestamp) : undefined);
      const messageIds = await fetchLabelMessageIds(labelId, afterDate);
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

  /** Cross-reference: for each message ID from a label query, add the label to its record and store the label index. When isInterrupted is provided, checks between batches and aborts early to prevent stale writes after account switch / cancellation. */
  private async crossReferenceLabel(labelId: string, messageIds: string[]): Promise<void> {
    // Store label→messageIds index for fast lookup in queryLabel and getLabelCounts
    const existingIndex = await db.getMeta<string[]>(`labelIdx:${labelId}`);
    if (existingIndex) {
      const merged = new Set(existingIndex);
      for (const id of messageIds) merged.add(id);
      await db.setMeta(`labelIdx:${labelId}`, [...merged]);
    } else {
      await db.setMeta(`labelIdx:${labelId}`, messageIds);
    }
  }

  /** Compute results for the current filter config and push via callback. No-op if no callback is registered, labels aren't loaded yet, or required data (scope) isn't available yet. Pass fromOrchestrator=true to bypass the initial-build guard (the orchestrator pushes progressively after each label). */
  private async pushResults(fromOrchestrator?: boolean): Promise<void> {
    if (!this.onResult) return;
    // Skip when labels haven't loaded — counts would be empty/wrong. The orchestrator will push after labels arrive.
    if (this.labels.length === 0) return;
    // During initial build, push labels without counts so the sidepanel clears stale data.
    // The orchestrator pushes progressively after each label is indexed.
    if (this.cacheDepthTimestamp === undefined && !fromOrchestrator) {
      this.onResult({ labelId: this.filterConfig.labelId, count: 0, coLabelCounts: {}, counts: {}, filterConfig: { ...this.filterConfig }, partial: true });
      return;
    }
    const config = { ...this.filterConfig };
    // If scope is needed but not yet cached, skip — orchestrator will push after scope arrives
    if (config.scopeTimestamp !== null && !this.scopedIdSets.has(config.scopeTimestamp)) return;
    const myGeneration = ++this.pushGeneration;
    try {
      let count = 0;
      let coLabelCounts: Record<string, number> = {};
      if (config.labelId !== null) {
        const result = await this.queryLabel(config.labelId, config.includeChildren, config.scopeTimestamp);
        // Discard if a newer pushResults call started or filter config changed during async work
        if (this.pushGeneration !== myGeneration) return;
        count = result.count;
        coLabelCounts = result.coLabelCounts;
      }
      const counts = await this.getLabelCounts(undefined, config.scopeTimestamp);
      // Discard if a newer pushResults call started or filter config changed during async work
      if (this.pushGeneration !== myGeneration) return;
      this.onResult({ labelId: config.labelId, count, coLabelCounts, counts, filterConfig: config, partial: this.cacheDepthTimestamp === undefined });
    } catch {
      // Swallow errors — push is best-effort
    }
  }

  private emitProgress(progress: CacheProgress): void {
    if (this.onProgress) this.onProgress(progress);
  }

  /** Map an orchestrator action type to a CacheProgress phase. */
  private orchestratorProgressPhase(action: OrchestratorAction): CacheProgress["phase"] {
    switch (action.type) {
      case "fetch-scope": return "scope";
      case "fetch-label": return "labels";
      case "refresh-label": return "labels";
    }
  }

  /** Resolve a label ID to its display name. */
  private labelName(labelId: string): string | undefined {
    return this.labels.find(l => l.id === labelId)?.name;
  }

  /** Emit progress based on the last completed orchestrator action. Null = idle/complete. */
  private emitOrchestratorProgress(action: OrchestratorAction | null): void {
    if (!action) {
      if (this.lastProgressWasComplete) return;
      this.lastProgressWasComplete = true;
      this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
      return;
    }
    this.lastProgressWasComplete = false;
    const queryList = this.buildLabelQueryList();
    const labelsTotal = queryList.length;
    switch (action.type) {
      case "fetch-scope": {
        const scopeKey = action.scopeTimestamp ?? this.filterConfig.scopeTimestamp ?? 0;
        const count = this.scopeAccumulators.get(scopeKey)?.length ?? 0;
        this.emitProgress({ phase: "scope", labelsTotal: 0, labelsDone: count });
        break;
      }
      case "fetch-label": {
        this.emitProgress({ phase: "labels", labelsTotal, labelsDone: this.processedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
      case "refresh-label": {
        this.emitProgress({ phase: "labels", labelsTotal, labelsDone: this.refreshProcessedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
    }
  }
}
