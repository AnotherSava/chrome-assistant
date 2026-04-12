import type { GmailLabel } from "@core/types.js";
import * as db from "./cache-db.js";
import { fetchLabels, fetchLabelMessageIdsPage, fetchScopedMessageIdsPage } from "./gmail-api.js";

/** System labels always cached */
const BASE_SYSTEM_LABELS = ["INBOX", "SENT"];
/** Synthetic label ID for messages with no user-created labels (has:nouserlabels) */
const NONE_LABEL_ID = "NONE";

export interface CacheProgress {
  phase: "labels" | "scope" | "complete";
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
  phase: "complete";
  lastFetchTimestamp: number | null;
}

export class CacheManager {
  private labels: GmailLabel[] = [];
  private onProgress: ProgressCallback | null = null;
  private onResult: ResultCallback | null = null;
  /** Generation counter for pushResults — incremented on each call so stale async completions are discarded. */
  private pushGeneration = 0;
  /** Labels already processed (by priority or main loop) — skipped by main loop. */
  private processedLabels = new Set<string>();
  /** In-memory accumulator for multi-page fetch-label — accumulates message IDs per label, writes to IndexedDB only when the label is complete (all pages fetched). Avoids expensive per-page read+merge+write cycles. */
  private labelIdAccumulator = new Map<string, string[]>();
  showStarred = false;
  showImportant = false;
  /** Per-timestamp cache of scoped ID sets — enables correct on-the-fly intersection when multiple windows use different scopes. Populated by executeAction(fetch-scope). */
  private scopedIdSets = new Map<number, Set<string>>();

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

  /** Get label index filtered by scope. When expectedScope is set and a cached scoped ID set exists, intersects the full label index with the scope set. Falls back to unscoped IndexedDB if no cached set is available. */
  private async getLabelIndex(labelId: string, expectedScope?: number | null): Promise<string[] | undefined> {
    if (expectedScope !== undefined && expectedScope !== null) {
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

    // Priority 4: Incremental refresh — cache is complete but stale
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
      throw err;
    }

    // Bail out if another start() was called during the async setup phase
    if (myGeneration !== this.startGeneration) {
      this.orchestratorRunning = false;
      return;
    }

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

  /** Populate the in-memory labels list without running a full fetch (e.g. after service worker restart with fresh cache). */
  async loadLabels(): Promise<void> {
    this.labels = await fetchLabels();
    if (!this.labels.some(l => l.id === NONE_LABEL_ID)) this.labels.push({ id: NONE_LABEL_ID, name: "No user labels", type: "system" });
  }

  /** Get own and inclusive counts for all known labels. When expectedScope is set and a cached scoped ID set exists, counts are filtered by scope intersection. Accepts an optional labels override for when this.labels is empty (e.g. after service worker restart with fresh cache). */
  async getLabelCounts(labelsOverride?: GmailLabel[], expectedScope?: number | null): Promise<Record<string, { own: number; inclusive: number }>> {
    let labels = labelsOverride && labelsOverride.length > 0 ? labelsOverride : this.labels;
    // Include synthetic NONE label if not already present
    if (labels.length > 0 && !labels.some(l => l.id === NONE_LABEL_ID)) labels = [...labels, { id: NONE_LABEL_ID, name: "No user labels", type: "system" }];
    // Check if a cached scoped ID set is available for scope-filtered counting
    const useScope = expectedScope !== undefined && expectedScope !== null && this.scopedIdSets.has(expectedScope);

    // Build own counts from label indexes
    const ownCounts: Record<string, number> = {};
    for (const label of labels) {
      const msgIds = await this.getLabelIndex(label.id, expectedScope);
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
        const msgIds = await this.getLabelIndex(lid, expectedScope);
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

  /** Query the cache for a label's message count and co-occurring labels. Resolves descendants internally via prefix matching when includeChildren is true. When expectedScope is set and a cached scoped ID set exists, results are filtered by scope intersection. */
  async queryLabel(labelId: string, includeChildren: boolean, expectedScope?: number | null): Promise<LabelQueryResult> {
    const labelIds = this.resolveLabelIds(labelId, includeChildren);

    // Build the set of message IDs for the selected label(s).
    // If a label hasn't been cached yet, the orchestrator's Priority 2 (selected label)
    // will fetch it, and pushResults will deliver results once the label is indexed.
    const selectedMsgIds = new Set<string>();
    for (const lid of labelIds) {
      const msgIds = await this.getLabelIndex(lid, expectedScope);
      if (msgIds) {
        for (const id of msgIds) selectedMsgIds.add(id);
      }
    }

    // Compute co-label counts by intersecting each label's index with the selected message IDs
    const coLabelCounts: Record<string, number> = {};
    const coLabels = this.labels.some(l => l.id === NONE_LABEL_ID) ? this.labels : [...this.labels, { id: NONE_LABEL_ID, name: "No user labels", type: "system" }];
    for (const label of coLabels) {
      if (label.id === labelId) continue;
      const otherIndex = await this.getLabelIndex(label.id, expectedScope);
      if (!otherIndex) continue;
      let count = 0;
      for (const id of otherIndex) {
        if (selectedMsgIds.has(id)) count++;
      }
      if (count > 0) coLabelCounts[label.id] = count;
    }

    return { labelId, count: selectedMsgIds.size, coLabelCounts };
  }

  /** Mark a label as processed so decide() skips it.
   *  Used by start() to register labels whose indexes already exist in IndexedDB. */
  markProcessed(labelId: string): void {
    this.processedLabels.add(labelId);
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

    // Synthetic "no user labels" label — included when real labels are loaded
    if (this.labels.length > 0 && !addedIds.has(NONE_LABEL_ID)) {
      result.push({ id: NONE_LABEL_ID, name: "No user labels", type: "system" });
      addedIds.add(NONE_LABEL_ID);
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
      this.onResult({ labelId: null, count: 0, coLabelCounts: {}, counts: {}, filterConfig: { ...this.filterConfig }, partial: true });
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
      const allProcessed = this.buildLabelQueryList().every(l => this.processedLabels.has(l.id));
      this.onResult({ labelId: config.labelId, count, coLabelCounts, counts, filterConfig: config, partial: this.cacheDepthTimestamp === undefined || !allProcessed });
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
