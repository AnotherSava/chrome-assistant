import type { CacheMessage, GmailLabel } from "@core/types.js";
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

export interface FilterConfig {
  labelId: string | null;
  includeChildren: boolean;
  scopeTimestamp: number | null;
}

export type OrchestratorActionType = "fetch-scope" | "fetch-label" | "gap-fill-label" | "expand-label" | "refresh-label";

export interface OrchestratorAction {
  type: OrchestratorActionType;
  labelId?: string;
  pageToken?: string;
  scopeDate?: string;
  beforeDate?: string;
  /** The scope timestamp this action targets — used to store results in scopedIdSets under the correct key (needed when fetching a requested scope that differs from filterConfig.scopeTimestamp). */
  scopeTimestamp?: number;
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
  /** Monotonically increasing generation for gap-fill — prevents stale gap-fills from writing results after a newer scope change. */
  private gapFillGen = 0;

  // --- Orchestrator state ---
  /** Current filter configuration set by the service worker. */
  private filterConfig: FilterConfig = { labelId: null, includeChildren: false, scopeTimestamp: null };
  /** Whether the orchestrator loop is running. */
  private orchestratorRunning = false;
  /** Number of parallel API calls the orchestrator may issue per iteration. */
  private orchestratorConcurrency = 1;
  /** In-progress pagination state, keyed by action type + label ID. */
  private continuations = new Map<string, Continuation>();
  /** Wake resolver for the orchestrator's idle sleep. */
  private orchestratorWakeResolve: (() => void) | null = null;
  /** Promise that resolves when the orchestrator loop exits — used by start() to await termination of a previous loop. */
  private loopPromise: Promise<void> | null = null;
  /** Monotonic counter to detect stale start() calls — prevents concurrent loops when start() is called during async setup. */
  private startGeneration = 0;
  /** Accumulator for multi-page scope fetch. */
  private scopeAccumulator: string[] = [];
  /** In-memory mirror of cacheDepth from IndexedDB. undefined = not yet determined. */
  private cacheDepthTimestamp: number | null | undefined = undefined;
  /** In-memory mirror of lastFetchTimestamp from fetchState. */
  private lastRefreshTimestamp: number | null = null;
  /** Configuration for current gap-fill cycle. null = no gap-fill in progress. */
  private gapFillConfig: { afterDate: string; beforeDate: string; targetTimestamp: number | null } | null = null;
  /** Labels that completed gap-fill in the current cycle. */
  private gapFillProcessedLabels = new Set<string>();
  /** Target timestamp for the current expansion tier. undefined = not computed yet. */
  private currentExpansionTarget: number | null | undefined = undefined;
  /** Labels that completed expansion in the current tier. */
  private expansionProcessedLabels = new Set<string>();
  /** Whether the last emitted progress was "complete" — prevents redundant re-emission on idle wakes. */
  private lastProgressWasComplete = false;
  /** Labels that completed refresh in the current cycle. */
  private refreshProcessedLabels = new Set<string>();
  /** Additional scope timestamps requested by ports (multi-window) that the orchestrator should fetch even if they differ from the global filterConfig.scopeTimestamp. Entries are removed once the scope is fetched. */
  private requestedScopes = new Set<number>();
  /** Resolve function for the error backoff sleep — called by stop() to interrupt backoff. */
  private errorBackoffResolve: (() => void) | null = null;
  /** Timeout ID for the error backoff timer — cleared by stop() to prevent stale callbacks from nulling a future errorBackoffResolve. */
  private errorBackoffTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Tracks the most restrictive (shallowest) scope timestamp used across labels during the initial build. Used to correctly set cacheDepthTimestamp when the build completes even if the user changed scope mid-build. undefined = not yet tracking, null = some label used no scope (all time). */
  private initialBuildNarrowestScope: number | null | undefined = undefined;
  /** Staleness threshold for incremental refresh (10 minutes). */
  private static readonly REFRESH_STALE_MS = 10 * 60 * 1000;

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
      await this.crossReferenceLabel(label.id, messageIds, () => generation !== this.gapFillGen);
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

  /** Update the filter configuration and wake the orchestrator if idle. */
  setFilterConfig(config: FilterConfig): void {
    this.filterConfig = { ...config };
    this.lastProgressWasComplete = false;
    this.wakeOrchestrator();
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

  /** Wake the orchestrator loop from idle sleep. */
  wakeOrchestrator(): void {
    if (this.orchestratorWakeResolve) {
      const resolve = this.orchestratorWakeResolve;
      this.orchestratorWakeResolve = null;
      resolve();
    }
  }

  /** Request the orchestrator to fetch a scope timestamp (used by multi-window pushUpdatedResults to ensure all active scopes are fetched, not just the global filterConfig scope). No-op if the scope is already cached. Wakes the orchestrator. */
  requestScopeFetch(scopeTimestamp: number): void {
    if (this.scopedIdSets.has(scopeTimestamp)) return;
    this.requestedScopes.add(scopeTimestamp);
    this.wakeOrchestrator();
  }

  /** Wait until the scoped ID set for the given timestamp is available (fetched by the orchestrator). Returns true if the scope is ready, false if the wait timed out or the orchestrator stopped before the scope was available. Resolves immediately with true if the set already exists or if scopeTimestamp is null. Times out after 30 seconds to prevent indefinite hangs. */
  waitForScopeReady(scopeTimestamp: number | null): Promise<boolean> {
    if (scopeTimestamp === null || this.scopedIdSets.has(scopeTimestamp)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 30_000);
      const check = (): void => {
        if (settled) return;
        if (this.scopedIdSets.has(scopeTimestamp)) { settled = true; clearTimeout(timeout); resolve(true); return; }
        if (!this.orchestratorRunning) { settled = true; clearTimeout(timeout); resolve(false); return; }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /** Sleep until woken by setFilterConfig() or wakeOrchestrator(). */
  private orchestratorSleep(): Promise<void> {
    return new Promise(resolve => { this.orchestratorWakeResolve = resolve; });
  }

  private continuationKey(type: OrchestratorActionType, labelId?: string): string {
    return `${type}:${labelId ?? ""}`;
  }

  /** Return the widest (oldest / smallest timestamp) scope across the global filterConfig, pending requestedScopes, and already-fetched scopedIdSets. Fetched scopes are removed from requestedScopes but retained in scopedIdSets, so we must check both to ensure gap-fill covers the widest scope any window has used. */
  private widestActiveScope(): number | null {
    let widest = this.filterConfig.scopeTimestamp;
    for (const ts of this.requestedScopes) {
      if (widest === null || ts < widest) widest = ts;
    }
    for (const ts of this.scopedIdSets.keys()) {
      if (widest === null || ts < widest) widest = ts;
    }
    return widest;
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
    // Also check requestedScopes from multi-window ports that need scopes other than the global filterConfig scope.
    const neededScope = this.filterConfig.scopeTimestamp !== null && !this.scopedIdSets.has(this.filterConfig.scopeTimestamp) ? this.filterConfig.scopeTimestamp : this.nextRequestedScope();
    if (neededScope !== null) {
      const scopeDate = this.timestampToDateString(neededScope);
      const key = this.continuationKey("fetch-scope");
      const cont = this.continuations.get(key);
      if (cont && cont.scopeDate === scopeDate) {
        tryAdd({ type: "fetch-scope", pageToken: cont.nextPageToken, scopeDate, scopeTimestamp: neededScope });
      } else {
        if (cont) { this.continuations.delete(key); this.scopeAccumulator = []; }
        tryAdd({ type: "fetch-scope", scopeDate, scopeTimestamp: neededScope });
      }
    }

    // Priority 2: Selected label missing — user selected a label but it's not cached
    // When cache depth is already established (post-initial-build), use it so the new label
    // gets the same coverage as existing labels. Otherwise use the UI scope for fast results.
    if (this.filterConfig.labelId !== null && !this.processedLabels.has(this.filterConfig.labelId)) {
      const labelId = this.filterConfig.labelId;
      const key = this.continuationKey("fetch-label", labelId);
      const cont = this.continuations.get(key);
      const selectedLabelScopeTs = this.cacheDepthTimestamp !== undefined ? this.cacheDepthTimestamp : this.filterConfig.scopeTimestamp;
      const scopeDate = selectedLabelScopeTs !== null ? this.timestampToDateString(selectedLabelScopeTs) : undefined;
      if (cont && cont.scopeDate === scopeDate) {
        tryAdd({ type: "fetch-label", labelId, pageToken: cont.nextPageToken, scopeDate });
      } else {
        if (cont) this.continuations.delete(key);
        tryAdd({ type: "fetch-label", labelId, scopeDate });
      }
    }

    // Priority 3: Initial cache build — labels not yet fully indexed
    const queryList = this.buildLabelQueryList();
    // When cache depth is already established (e.g. a new label was enabled after initial build),
    // fetch to the existing depth so the new label matches other labels' coverage.
    // When depth is null (full history), fetch without scope restriction.
    // During the first build (cacheDepthTimestamp === undefined), use the UI scope.
    const initialBuildScopeTs = this.cacheDepthTimestamp !== undefined ? this.cacheDepthTimestamp : this.filterConfig.scopeTimestamp;
    const scopeDate = initialBuildScopeTs !== null ? this.timestampToDateString(initialBuildScopeTs) : undefined;
    for (const label of queryList) {
      if (actions.length >= concurrency) break;
      if (this.processedLabels.has(label.id)) continue;
      if (usedLabels.has(label.id)) continue;
      const key = this.continuationKey("fetch-label", label.id);
      const cont = this.continuations.get(key);
      if (cont && cont.scopeDate === scopeDate) {
        tryAdd({ type: "fetch-label", labelId: label.id, pageToken: cont.nextPageToken, scopeDate });
      } else {
        if (cont) this.continuations.delete(key);
        tryAdd({ type: "fetch-label", labelId: label.id, scopeDate });
      }
    }

    // Check if initial build is complete — lower priorities only apply after all labels are indexed
    const initialBuildComplete = queryList.every(l => this.processedLabels.has(l.id));
    if (!initialBuildComplete || actions.length > 0) return actions;

    // Priority 4: Gap-fill — scope wider than cache depth
    // Use the widest (oldest) scope across the global filter and all requested scopes
    // so secondary windows also get gap-fill, not just the global filter's window.
    const gapFillScope = this.widestActiveScope();
    if (this.cacheDepthTimestamp !== undefined && this.cacheDepthTimestamp !== null && gapFillScope !== null && gapFillScope < this.cacheDepthTimestamp) {
      const afterDate = this.timestampToDateString(gapFillScope);
      const beforeDate = this.timestampToDateString(this.cacheDepthTimestamp);
      const targetTimestamp = this.normalizeToMidnight(gapFillScope);
      if (!this.gapFillConfig || this.gapFillConfig.afterDate !== afterDate || this.gapFillConfig.beforeDate !== beforeDate) {
        this.gapFillConfig = { afterDate, beforeDate, targetTimestamp };
        this.gapFillProcessedLabels.clear();
        for (const [k] of this.continuations) { if (k.startsWith("gap-fill-label:")) this.continuations.delete(k); }
      }
      for (const label of queryList) {
        if (actions.length >= concurrency) break;
        if (this.gapFillProcessedLabels.has(label.id)) continue;
        if (usedLabels.has(label.id)) continue;
        const key = this.continuationKey("gap-fill-label", label.id);
        const cont = this.continuations.get(key);
        if (cont) {
          tryAdd({ type: "gap-fill-label", labelId: label.id, pageToken: cont.nextPageToken, scopeDate: afterDate, beforeDate });
        } else {
          tryAdd({ type: "gap-fill-label", labelId: label.id, scopeDate: afterDate, beforeDate });
        }
      }
      if (actions.length > 0) return actions;
    }

    // Priority 5: Background expansion — depth is partial, progressively deepen
    if (this.cacheDepthTimestamp !== undefined && this.cacheDepthTimestamp !== null) {
      if (this.currentExpansionTarget === undefined) {
        this.currentExpansionTarget = this.nextExpansionTier(this.cacheDepthTimestamp, new Date());
      }
      const afterDate = this.currentExpansionTarget !== null ? this.timestampToDateString(this.currentExpansionTarget) : undefined;
      const beforeDate = this.timestampToDateString(this.cacheDepthTimestamp);
      for (const label of queryList) {
        if (actions.length >= concurrency) break;
        if (this.expansionProcessedLabels.has(label.id)) continue;
        if (usedLabels.has(label.id)) continue;
        const key = this.continuationKey("expand-label", label.id);
        const cont = this.continuations.get(key);
        if (cont) {
          tryAdd({ type: "expand-label", labelId: label.id, pageToken: cont.nextPageToken, scopeDate: afterDate, beforeDate });
        } else {
          tryAdd({ type: "expand-label", labelId: label.id, scopeDate: afterDate, beforeDate });
        }
      }
      if (actions.length > 0) return actions;
    }

    // Priority 6: Incremental refresh — cache is complete but stale
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
    const key = this.continuationKey(action.type, action.labelId);

    // Cache the query list for isAllLabelsInSet checks within this action
    const queryList = action.type !== "fetch-scope" ? this.buildLabelQueryList() : undefined;

    switch (action.type) {
      case "fetch-scope": {
        const scopeTimestampForAction = action.scopeTimestamp ?? this.filterConfig.scopeTimestamp;
        const result = await fetchScopedMessageIdsPage(action.scopeDate!, action.pageToken);
        this.scopeAccumulator.push(...result.ids);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "fetch-scope", nextPageToken: result.nextPageToken, scopeDate: action.scopeDate });
        } else {
          this.continuations.delete(key);
          const scopeTimestamp = scopeTimestampForAction;
          if (scopeTimestamp !== null) {
            const scopedSet = new Set(this.scopeAccumulator);
            const MAX_SCOPED_ID_SETS = 5;
            if (this.scopedIdSets.size >= MAX_SCOPED_ID_SETS && !this.scopedIdSets.has(scopeTimestamp)) {
              const oldestKey = this.scopedIdSets.keys().next().value!;
              this.scopedIdSets.delete(oldestKey);
            }
            this.scopedIdSets.set(scopeTimestamp, scopedSet);
            this.requestedScopes.delete(scopeTimestamp);
          }
          this.scopeAccumulator = [];
        }
        break;
      }
      case "fetch-label": {
        // Capture scope timestamp before the async call — filterConfig may change during the await
        const scopeTimestampAtDispatch = this.filterConfig.scopeTimestamp;
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken, action.scopeDate, action.beforeDate);
        await this.crossReferenceLabel(action.labelId!, result.ids);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "fetch-label", labelId: action.labelId, nextPageToken: result.nextPageToken, scopeDate: action.scopeDate, beforeDate: action.beforeDate });
        } else {
          this.continuations.delete(key);
          this.processedLabels.add(action.labelId!);
          // Track the narrowest (shallowest) scope used during the initial build so
          // cacheDepthTimestamp reflects the actual coverage, not the scope at completion time.
          // Uses the scope timestamp captured before the await so a mid-flight scope change
          // doesn't overstate coverage.
          if (this.cacheDepthTimestamp === undefined) {
            const usedTs = scopeTimestampAtDispatch;
            if (usedTs !== null) {
              if (this.initialBuildNarrowestScope === undefined || this.initialBuildNarrowestScope === null || usedTs > this.initialBuildNarrowestScope) {
                this.initialBuildNarrowestScope = usedTs;
              }
            } else if (this.initialBuildNarrowestScope === undefined) {
              this.initialBuildNarrowestScope = null;
            }
          }
          if (this.isAllLabelsInSet(this.processedLabels, queryList)) {
            const now = Date.now();
            this.lastRefreshTimestamp = now;
            await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: now });
            // Only set cache depth on first-time initial build completion — don't regress
            // a deeper depth set by background expansion when a new label is added later
            if (this.cacheDepthTimestamp === undefined) {
              const scopeTs = this.initialBuildNarrowestScope !== undefined ? this.initialBuildNarrowestScope : this.filterConfig.scopeTimestamp;
              this.cacheDepthTimestamp = scopeTs !== null ? this.normalizeToMidnight(scopeTs) : null;
              await db.setMeta("cacheDepth", { timestamp: this.cacheDepthTimestamp ?? null });
              this.initialBuildNarrowestScope = undefined;
            }
            // Signal initial build completion so the service worker pushes results
            // before background expansion or gap-fill begins
            this.emitProgress({ phase: "complete", labelsTotal: 0, labelsDone: 0 });
          }
        }
        break;
      }
      case "gap-fill-label": {
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken, action.scopeDate, action.beforeDate);
        await this.crossReferenceLabel(action.labelId!, result.ids);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "gap-fill-label", labelId: action.labelId, nextPageToken: result.nextPageToken, scopeDate: action.scopeDate, beforeDate: action.beforeDate });
        } else {
          this.continuations.delete(key);
          this.gapFillProcessedLabels.add(action.labelId!);
          if (this.isAllLabelsInSet(this.gapFillProcessedLabels, queryList)) {
            const targetTimestamp = this.gapFillConfig?.targetTimestamp ?? null;
            this.cacheDepthTimestamp = targetTimestamp;
            await db.setMeta("cacheDepth", { timestamp: targetTimestamp });
            this.gapFillConfig = null;
            this.gapFillProcessedLabels.clear();
            // Reset expansion state — gap-fill deepened the cache past any in-progress expansion tier
            this.currentExpansionTarget = undefined;
            this.expansionProcessedLabels.clear();
            for (const [k] of this.continuations) { if (k.startsWith("expand-label:")) this.continuations.delete(k); }
            // Signal gap-fill completion so the service worker pushes updated counts
            this.emitProgress({ phase: "expanding", labelsTotal: 0, labelsDone: 0 });
          }
        }
        break;
      }
      case "expand-label": {
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken, action.scopeDate, action.beforeDate);
        await this.crossReferenceLabel(action.labelId!, result.ids);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "expand-label", labelId: action.labelId, nextPageToken: result.nextPageToken, scopeDate: action.scopeDate, beforeDate: action.beforeDate });
        } else {
          this.continuations.delete(key);
          this.expansionProcessedLabels.add(action.labelId!);
          if (this.isAllLabelsInSet(this.expansionProcessedLabels, queryList)) {
            this.cacheDepthTimestamp = this.currentExpansionTarget ?? null;
            await db.setMeta("cacheDepth", { timestamp: this.currentExpansionTarget ?? null });
            this.expansionProcessedLabels.clear();
            this.currentExpansionTarget = undefined;
            // Signal expansion tier completion so the service worker pushes updated counts
            this.emitProgress({ phase: "expanding", labelsTotal: 0, labelsDone: 0 });
          }
        }
        break;
      }
      case "refresh-label": {
        const result = await fetchLabelMessageIdsPage(action.labelId!, action.pageToken, action.scopeDate);
        await this.crossReferenceLabel(action.labelId!, result.ids);
        if (result.nextPageToken) {
          this.continuations.set(key, { type: "refresh-label", labelId: action.labelId, nextPageToken: result.nextPageToken, scopeDate: action.scopeDate });
        } else {
          this.continuations.delete(key);
          this.refreshProcessedLabels.add(action.labelId!);
          if (this.isAllLabelsInSet(this.refreshProcessedLabels, queryList)) {
            this.lastRefreshTimestamp = Date.now();
            await db.setMeta("fetchState", { phase: "complete", lastFetchTimestamp: this.lastRefreshTimestamp });
            this.refreshProcessedLabels.clear();
            // Invalidate all cached scope state so subsequent reads re-fetch
            // scoped IDs and re-compute intersections from fresh DB indexes.
            // scopedIdSets must also be cleared because refresh may have fetched
            // new messages that fall within the same time range.
            this.scopedLabelIdx = null;
            this.scopedIdSet = null;
            this.activeScopeTimestamp = undefined;
            this.scopedIdSets.clear();
            this.scopeFilterGen++;
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
          this.scopedIdSets.clear();
          this.scopedLabelIdx = null;
          this.scopedIdSet = null;
          this.activeScopeTimestamp = undefined;
          this.continuations.clear();
          this.scopeAccumulator = [];
          this.cacheDepthTimestamp = undefined;
          this.lastRefreshTimestamp = null;
          this.gapFillConfig = null;
          this.gapFillProcessedLabels.clear();
          this.currentExpansionTarget = undefined;
          this.expansionProcessedLabels.clear();
          this.refreshProcessedLabels.clear();
          this.requestedScopes.clear();
          this.initialBuildNarrowestScope = undefined;
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
    }

    const loop = async (): Promise<void> => {
      let errorBackoff = 1000;
      while (this.orchestratorRunning) {
        const actions = this.decide(this.orchestratorConcurrency);
        if (actions.length === 0) {
          this.emitOrchestratorProgress(null);
          await this.orchestratorSleep();
          continue;
        }
        try {
          await Promise.all(actions.map(action => this.executeAction(action)));
          this.emitOrchestratorProgress(actions[actions.length - 1]);
          errorBackoff = 1000; // reset on success
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
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
      await this.crossReferenceLabel(label.id, messageIds, () => this.isStale(generation));
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

      // If no index entry or empty index, the label hasn't been cached yet.
      // When the orchestrator is running, skip the blocking prioritizeLabel call — the
      // orchestrator's Priority 2 (selected label) will fetch it, and pushUpdatedResults
      // will deliver results once the label is indexed.  Calling prioritizeLabel while
      // the orchestrator loop is active would create concurrent API calls and risk lost
      // updates in crossReferenceLabel (two concurrent merges into the same labelIdx).
      if (!msgIds || msgIds.length === 0) {
        if (!this.orchestratorRunning) {
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
  private async crossReferenceLabel(labelId: string, messageIds: string[], isInterrupted?: () => boolean): Promise<void> {
    if (isInterrupted?.()) return;
    // Store label→messageIds index for fast lookup in queryLabel
    const existingIndex = await db.getMeta<string[]>(`labelIdx:${labelId}`);
    if (isInterrupted?.()) return;
    if (existingIndex) {
      const merged = new Set(existingIndex);
      for (const id of messageIds) merged.add(id);
      await db.setMeta(`labelIdx:${labelId}`, [...merged]);
    } else {
      await db.setMeta(`labelIdx:${labelId}`, messageIds);
    }
    const batchSize = 500;
    for (let i = 0; i < messageIds.length; i += batchSize) {
      if (isInterrupted?.()) return;
      const chunk = messageIds.slice(i, i + batchSize);
      const existingMap = await db.getMessagesBatch(chunk);
      if (isInterrupted?.()) return;
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

  /** Map an orchestrator action type to a CacheProgress phase. */
  private orchestratorProgressPhase(action: OrchestratorAction): CacheProgress["phase"] {
    switch (action.type) {
      case "fetch-scope": return "scope";
      case "fetch-label": return "labels";
      case "gap-fill-label":
      case "expand-label": return "expanding";
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
    const phase = this.orchestratorProgressPhase(action);
    switch (action.type) {
      case "fetch-scope": {
        const count = this.scopeAccumulator.length;
        this.emitProgress({ phase: "scope", labelsTotal: 0, labelsDone: count });
        break;
      }
      case "fetch-label": {
        this.emitProgress({ phase: "labels", labelsTotal, labelsDone: this.processedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
      case "gap-fill-label": {
        this.emitProgress({ phase: "expanding", labelsTotal, labelsDone: this.gapFillProcessedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
      case "expand-label": {
        this.emitProgress({ phase: "expanding", labelsTotal, labelsDone: this.expansionProcessedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
      case "refresh-label": {
        this.emitProgress({ phase: "labels", labelsTotal, labelsDone: this.refreshProcessedLabels.size, currentLabel: action.labelId ? this.labelName(action.labelId) : undefined });
        break;
      }
    }
  }
}
