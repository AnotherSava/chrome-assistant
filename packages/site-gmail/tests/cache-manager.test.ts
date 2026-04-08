import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CacheManager, type CacheProgress } from "../src/cache-manager.js";
import type { CacheMessage, GmailLabel } from "@core/types.js";

// Mock cache-db
vi.mock("../src/cache-db.js", () => {
  const store = new Map<string, CacheMessage>();
  const meta = new Map<string, unknown>();
  return {
    openDatabase: vi.fn().mockResolvedValue({}),
    closeDatabase: vi.fn().mockResolvedValue(undefined),
    putMessages: vi.fn(async (messages: CacheMessage[]) => { for (const m of messages) store.set(m.id, m); }),
    getMessage: vi.fn(async (id: string) => store.get(id)),
    getMessagesBatch: vi.fn(async (ids: string[]) => { const map = new Map<string, CacheMessage>(); for (const id of ids) { const m = store.get(id); if (m) map.set(id, m); } return map; }),
    getMeta: vi.fn(async (key: string) => meta.get(key)),
    setMeta: vi.fn(async (key: string, value: unknown) => { meta.set(key, value); }),
    clearAll: vi.fn(async () => { store.clear(); meta.clear(); }),
    getMessageCount: vi.fn(async () => store.size),
    _store: store,
    _meta: meta,
  };
});

// Mock gmail-api
vi.mock("../src/gmail-api.js", () => ({
  fetchLabels: vi.fn(),
  fetchLabelMessageIds: vi.fn(),
  fetchScopedMessageIds: vi.fn(),
}));

import * as dbMock from "../src/cache-db.js";
import * as apiMock from "../src/gmail-api.js";

const mockDb = dbMock as unknown as {
  putMessages: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  getMeta: ReturnType<typeof vi.fn>;
  setMeta: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  getMessageCount: ReturnType<typeof vi.fn>;
  _store: Map<string, CacheMessage>;
  _meta: Map<string, unknown>;
};

const mockApi = apiMock as unknown as {
  fetchLabels: ReturnType<typeof vi.fn>;
  fetchLabelMessageIds: ReturnType<typeof vi.fn>;
  fetchScopedMessageIds: ReturnType<typeof vi.fn>;
};

const testLabels: GmailLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "Label_1", name: "Work", type: "user" },
  { id: "Label_2", name: "Personal", type: "user" },
];

describe("CacheManager", () => {
  let manager: CacheManager;

  afterEach(() => {
    manager.abort();
  });

  beforeEach(() => {
    manager = new CacheManager();
    mockDb._store.clear();
    mockDb._meta.clear();
    vi.clearAllMocks();
    // Re-setup the default mock implementations after clearAllMocks
    mockDb.putMessages.mockImplementation(async (messages: CacheMessage[]) => { for (const m of messages) mockDb._store.set(m.id, m); });
    mockDb.getMessage.mockImplementation(async (id: string) => mockDb._store.get(id));
    mockDb.getMeta.mockImplementation(async (key: string) => mockDb._meta.get(key));
    mockDb.setMeta.mockImplementation(async (key: string, value: unknown) => { mockDb._meta.set(key, value); });
    mockDb.clearAll.mockImplementation(async () => { mockDb._store.clear(); mockDb._meta.clear(); });
    mockDb.getMessageCount.mockImplementation(async () => mockDb._store.size);
  });

  describe("startFetch", () => {
    it("runs label cross-referencing and completes", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      // INBOX has messages m1, m2; SENT has m2, m3; Work has m1; Personal has m3
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2", "m3"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m3"];
        return [];
      });

      const progressUpdates: CacheProgress[] = [];
      manager.setProgressCallback(p => progressUpdates.push({ ...p }));

      await manager.startFetch("/mail/u/0/");

      // Verify cross-referencing: m1 should have INBOX + Work, m2 should have INBOX + SENT, m3 should have SENT + Personal
      const m1 = mockDb._store.get("m1")!;
      const m2 = mockDb._store.get("m2")!;
      const m3 = mockDb._store.get("m3")!;
      expect(m1.labelIds).toContain("INBOX");
      expect(m1.labelIds).toContain("Label_1");
      expect(m2.labelIds).toContain("INBOX");
      expect(m2.labelIds).toContain("SENT");
      expect(m3.labelIds).toContain("SENT");
      expect(m3.labelIds).toContain("Label_2");

      // Verify progress includes label phase and complete (no dates phase)
      const phases = progressUpdates.map(p => p.phase);
      expect(phases).toContain("labels");
      expect(phases).not.toContain("dates");
      expect(phases[phases.length - 1]).toBe("complete");

      // Verify fetchState was saved
      const fetchState = mockDb._meta.get("fetchState") as { phase: string; lastFetchTimestamp: number };
      expect(fetchState.phase).toBe("complete");
      expect(fetchState.lastFetchTimestamp).toBeGreaterThan(0);
    });

    it("clears cache on account change", async () => {
      mockDb._meta.set("account", "/mail/u/1/");
      mockDb._store.set("old", { id: "old", labelIds: ["INBOX"] });

      mockApi.fetchLabels.mockResolvedValue([]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await manager.startFetch("/mail/u/0/");

      expect(mockDb.clearAll).toHaveBeenCalled();
    });

    it("does not clear cache when same account", async () => {
      mockDb._meta.set("account", "/mail/u/0/");

      mockApi.fetchLabels.mockResolvedValue([]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await manager.startFetch("/mail/u/0/");

      expect(mockDb.clearAll).not.toHaveBeenCalled();
    });

    it("supports incremental refresh with scope date", async () => {
      // Simulate a previous completed fetch with existing label indexes
      mockDb._meta.set("fetchState", { phase: "complete", lastFetchTimestamp: 1700000000000 });
      mockDb._meta.set("account", "/mail/u/0/");
      mockDb._meta.set("labelIdx:INBOX", ["m1"]);
      mockDb._meta.set("labelIdx:SENT", ["m1"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m1"]);

      mockApi.fetchLabels.mockResolvedValue(testLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);


      await manager.startFetch("/mail/u/0/");

      // fetchLabelMessageIds should have been called with a scopeDate derived from the timestamp
      const calls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Each call should have a second argument (the scope date string)
      for (const call of calls) {
        expect(call[1]).toBeDefined();
        expect(call[1]).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
      }
    });

    it("initial build with scope stores scoped label indexes and correct cacheDepth", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m2"];
        return [];
      });

      const scopeTimestamp = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year ago
      await manager.startFetch("/mail/u/0/", scopeTimestamp);

      // fetchLabelMessageIds should have been called with the scope date string
      const calls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1]).toBeDefined();
        expect(call[1]).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
      }

      // cacheDepth should be stored normalized to midnight (matching UI scopeToTimestamp behavior)
      const cacheDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(cacheDepth).toBeDefined();
      const expectedMidnight = new Date(scopeTimestamp);
      expectedMidnight.setHours(0, 0, 0, 0);
      expect(cacheDepth.timestamp).toBe(expectedMidnight.getTime());

      // Label indexes should be stored
      const inboxIdx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(inboxIdx).toEqual(["m1", "m2"]);
    });

    it("initial build without scope stores full indexes and cacheDepth null", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2", "m3"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m3"];
        return [];
      });

      await manager.startFetch("/mail/u/0/");

      // fetchLabelMessageIds should have been called without scope date (undefined)
      const calls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1]).toBeUndefined();
      }

      // cacheDepth should be null (full coverage)
      const cacheDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(cacheDepth).toBeDefined();
      expect(cacheDepth.timestamp).toBeNull();
    });

    it("can be aborted during label fetch", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      let callCount = 0;
      mockApi.fetchLabelMessageIds.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) manager.abort();
        return [];
      });

      await manager.startFetch("/mail/u/0/");

      // Should have stopped after 2 label fetches (aborted on second)
      expect(callCount).toBe(2);
    });
  });

  describe("queryLabel", () => {
    beforeEach(() => {
      // Populate cache with test data
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["INBOX", "SENT", "Label_1"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["SENT", "Label_2"] });
      mockDb._store.set("m4", { id: "m4", labelIds: ["INBOX", "Label_2"] });
      // Populate label index (mirrors what crossReferenceLabel stores)
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m4"]);
      mockDb._meta.set("labelIdx:SENT", ["m2", "m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3", "m4"]);
    });

    it("returns count and co-occurring labels for a label", async () => {
      const result = await manager.queryLabel("INBOX", false);
      expect(result.count).toBe(3); // m1, m2, m4
      expect(result.coLabelCounts).toHaveProperty("Label_1");
      expect(result.coLabelCounts).toHaveProperty("SENT");
      expect(result.coLabelCounts).toHaveProperty("Label_2");
    });

    it("returns all messages for a label without location filtering", async () => {
      const result = await manager.queryLabel("Label_1", false);
      expect(result.count).toBe(2); // m1, m2
    });

    it("returns filtered results when scope filter is active", async () => {
      // Set scope filter — only m2 and m4 are in scope
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m4"]);
      manager.setLabels(testLabels);
      await manager.setScopeFilter(2500);

      const result = await manager.queryLabel("INBOX", false);
      expect(result.count).toBe(2); // m2 and m4 are in scoped INBOX index
    });

    it("returns empty result for unknown label", async () => {
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);
      const result = await manager.queryLabel("NONEXISTENT", false);
      expect(result.count).toBe(0);
      expect(result.coLabelCounts).toEqual({});
    });

    it("prioritizes uncached label when cache is still building", async () => {
      // Simulate cache in labels phase
      mockDb._meta.set("fetchState", { phase: "labels", lastFetchTimestamp: null });
      // The priority fetch will call fetchLabelMessageIds for the uncached label
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m10", "m11"]);
      const result = await manager.queryLabel("Label_priority", false);
      expect(mockApi.fetchLabelMessageIds).toHaveBeenCalledWith("Label_priority", undefined);
      expect(result.count).toBe(2);
      // Label index should now be in the DB for subsequent queries
      const labelIdx = mockDb._meta.get("labelIdx:Label_priority") as string[];
      expect(labelIdx).toHaveLength(2);
    });

    it("resolves descendants via prefix matching when includeChildren is true", async () => {
      // Setup labels with hierarchy: Work, Work/Projects, Work/Projects/Alpha
      const hierarchyLabels: GmailLabel[] = [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
        { id: "Label_2", name: "Work/Projects", type: "user" },
        { id: "Label_3", name: "Work/Projects/Alpha", type: "user" },
        { id: "Label_4", name: "Personal", type: "user" },
      ];
      // Populate labels on the manager via startFetch
      mockApi.fetchLabels.mockResolvedValue(hierarchyLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/");

      // Populate cache: Work has m1, Work/Projects has m2, Work/Projects/Alpha has m3
      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["Label_1", "Label_2"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["Label_3"] });
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", ["m3"]);

      // Query Work with includeChildren — should include Work, Work/Projects, Work/Projects/Alpha
      const result = await mgr.queryLabel("Label_1", true);
      expect(result.labelId).toBe("Label_1");
      expect(result.count).toBe(3); // m1, m2, m3 (deduplicated)
      // Label_2 and Label_3 should appear as co-labels (only Label_1 excluded as primary)
      expect(result.coLabelCounts).toHaveProperty("Label_2");
      expect(result.coLabelCounts).toHaveProperty("Label_3");
      expect(result.coLabelCounts).not.toHaveProperty("Label_1");
    });

    it("does not include descendants when includeChildren is false", async () => {
      const hierarchyLabels: GmailLabel[] = [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
        { id: "Label_2", name: "Work/Projects", type: "user" },
      ];
      mockApi.fetchLabels.mockResolvedValue(hierarchyLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/");

      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["Label_2"] });
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);

      // Query Work without children — should only get m1
      const result = await mgr.queryLabel("Label_1", false);
      expect(result.count).toBe(1);
    });
  });

  describe("getLabelCounts", () => {
    const hierarchyLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Work/Projects", type: "user" },
      { id: "Label_3", name: "Work/Projects/Alpha", type: "user" },
      { id: "Label_4", name: "Personal", type: "user" },
    ];

    async function setupManagerWithLabels(labels: GmailLabel[]): Promise<CacheManager> {
      const mgr = new CacheManager();
      mockApi.fetchLabels.mockResolvedValue(labels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await mgr.startFetch("/mail/u/0/");
      return mgr;
    }

    it("returns correct own counts per label", async () => {
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["INBOX", "Label_1", "Label_2"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["SENT", "Label_4"] });
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:SENT", ["m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", ["m3"]);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts();

      expect(counts["INBOX"].own).toBe(2);
      expect(counts["SENT"].own).toBe(1);
      expect(counts["Label_1"].own).toBe(2);
      expect(counts["Label_2"].own).toBe(1);
      expect(counts["Label_3"].own).toBe(0);
      expect(counts["Label_4"].own).toBe(1);
    });

    it("returns correct inclusive counts for parent labels (deduplicated)", async () => {
      // m1: Work only, m2: Work + Work/Projects, m3: Work/Projects/Alpha only
      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["Label_1", "Label_2"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["Label_3"] });
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", ["m3"]);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts();

      // Work inclusive = m1 + m2 + m3 (deduplicated, m2 appears in both Work and Work/Projects)
      expect(counts["Label_1"].inclusive).toBe(3);
      // Work/Projects inclusive = m2 + m3 (Work/Projects + Work/Projects/Alpha)
      expect(counts["Label_2"].inclusive).toBe(2);
      // Work/Projects/Alpha is a leaf — inclusive == own
      expect(counts["Label_3"].inclusive).toBe(1);
      expect(counts["Label_3"].own).toBe(1);
      // Personal is a leaf
      expect(counts["Label_4"].inclusive).toBe(0);
      expect(counts["Label_4"].own).toBe(0);
    });

    it("filters counts by scope via setScopeFilter", async () => {
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["INBOX", "Label_2"] });
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m3"]);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      // Scope returns only m2 and m3 (messages after scope date)
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);
      await mgr.setScopeFilter(3000);
      const counts = await mgr.getLabelCounts();

      expect(counts["Label_1"].own).toBe(1); // m2 only
      expect(counts["Label_2"].own).toBe(1); // m3
      expect(counts["INBOX"].own).toBe(2); // m2, m3
    });

    it("omits labels with own=0 and inclusive=0 when scope is active", async () => {
      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["Label_2"] });
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      // Scope returns only m2 (recent)
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2"]);
      await mgr.setScopeFilter(3000);
      const counts = await mgr.getLabelCounts();

      // INBOX, SENT, Label_3, Label_4 all have own=0 and inclusive=0 — should be omitted
      expect(counts).not.toHaveProperty("INBOX");
      expect(counts).not.toHaveProperty("SENT");
      expect(counts).not.toHaveProperty("Label_3");
      expect(counts).not.toHaveProperty("Label_4");
      // Label_1 has own=0 but inclusive>0 (via Label_2), Label_2 has own=1
      expect(counts).toHaveProperty("Label_1");
      expect(counts).toHaveProperty("Label_2");
    });

    it("keeps labels with own=0 but inclusive>0 when scope is active", async () => {
      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["Label_2"] });
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      // Scope returns only m2 (recent, in Label_2/Work/Projects)
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2"]);
      await mgr.setScopeFilter(3000);
      const counts = await mgr.getLabelCounts();

      // Work: own=0 (m1 not in scope), inclusive=1 (m2 via Work/Projects)
      expect(counts["Label_1"].own).toBe(0);
      expect(counts["Label_1"].inclusive).toBe(1);
    });

    it("includes labels with own=0 when scope is null", async () => {
      mockDb._store.set("m1", { id: "m1", labelIds: ["Label_1"] });
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", []);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts();

      // All labels with a labelIdx entry should be present, even with zero counts
      expect(counts).toHaveProperty("INBOX");
      expect(counts).toHaveProperty("SENT");
      expect(counts["INBOX"].own).toBe(0);
      expect(counts["SENT"].own).toBe(0);
      expect(counts["Label_4"].own).toBe(0);
      expect(counts["Label_4"].inclusive).toBe(0);
    });
  });

  describe("buildLabelQueryList", () => {
    it("includes STARRED when showStarred is on", async () => {
      const mgr = new CacheManager();
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await mgr.startFetch("/mail/u/0/");

      mgr.updateSystemLabelSettings(true, false);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("INBOX");
      expect(ids).toContain("SENT");
      expect(ids).toContain("STARRED");
      expect(ids).not.toContain("IMPORTANT");
      // STARRED should come before user labels
      expect(ids.indexOf("STARRED")).toBeLessThan(ids.indexOf("Label_1"));
    });

    it("excludes STARRED when showStarred is off", async () => {
      const mgr = new CacheManager();
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await mgr.startFetch("/mail/u/0/");

      mgr.updateSystemLabelSettings(false, false);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("INBOX");
      expect(ids).toContain("SENT");
      expect(ids).not.toContain("STARRED");
    });

    it("includes IMPORTANT when showImportant is on", async () => {
      const mgr = new CacheManager();
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await mgr.startFetch("/mail/u/0/");

      mgr.updateSystemLabelSettings(false, true);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("IMPORTANT");
      expect(ids).not.toContain("STARRED");
    });

    it("includes both STARRED and IMPORTANT when both settings are on", async () => {
      const mgr = new CacheManager();
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      await mgr.startFetch("/mail/u/0/");

      mgr.updateSystemLabelSettings(true, true);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("STARRED");
      expect(ids).toContain("IMPORTANT");
      // Order: INBOX, SENT, STARRED, IMPORTANT, then user labels
      expect(ids.indexOf("STARRED")).toBeLessThan(ids.indexOf("IMPORTANT"));
      expect(ids.indexOf("IMPORTANT")).toBeLessThan(ids.indexOf("Label_1"));
    });
  });

  describe("setScopeFilter", () => {
    const scopeLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];

    beforeEach(() => {
      // Populate label indexes
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m3"]);
      mockDb._meta.set("labelIdx:SENT", ["m2", "m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3"]);
      // Populate message records
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["INBOX", "SENT", "Label_1"] });
      mockDb._store.set("m3", { id: "m3", labelIds: ["INBOX", "SENT", "Label_2"] });
    });

    it("queryLabel with scope returns filtered results", async () => {
      manager.setLabels(scopeLabels);
      // Scope includes only m2 and m3
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);
      await manager.setScopeFilter(2000);

      const result = await manager.queryLabel("INBOX", false);
      expect(result.count).toBe(2); // m2, m3 (m1 not in scope)
      expect(result.coLabelCounts["Label_1"]).toBe(1); // m2 only
      expect(result.coLabelCounts["Label_2"]).toBe(1); // m3 only
    });

    it("getLabelCounts with scope returns filtered counts", async () => {
      manager.setLabels(scopeLabels);
      // Scope includes only m3
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m3"]);
      await manager.setScopeFilter(2500);

      const counts = await manager.getLabelCounts();
      expect(counts["INBOX"].own).toBe(1);
      expect(counts["SENT"].own).toBe(1);
      expect(counts["Label_2"].own).toBe(1);
      // Label_1 has no messages in scope — should be omitted
      expect(counts).not.toHaveProperty("Label_1");
    });

    it("null scope reads from IndexedDB directly", async () => {
      manager.setLabels(scopeLabels);
      // First set a scope
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m3"]);
      await manager.setScopeFilter(2500);

      // Now clear scope
      await manager.setScopeFilter(null);

      const result = await manager.queryLabel("INBOX", false);
      expect(result.count).toBe(3); // All three messages from IndexedDB label index
    });

    it("multi-window: overwritten scope still returns correct filtered results via cached scoped ID set", async () => {
      manager.setLabels(scopeLabels);
      // Window 1 sets scope to 2000 — only m2 and m3 in scope
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);
      await manager.setScopeFilter(2000);

      // Window 2 sets scope to 3000 — only m3 in scope (overwrites active scope)
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m3"]);
      await manager.setScopeFilter(3000);

      // Query with expectedScope=2000 (Window 1's scope) — should use cached scoped ID set, not unscoped
      const result = await manager.queryLabel("INBOX", false, 2000);
      expect(result.count).toBe(2); // m2 and m3 — filtered by scope 2000, not unscoped (3) or scope 3000 (1)

      const counts = await manager.getLabelCounts(undefined, 2000);
      expect(counts["INBOX"].own).toBe(2);
      // Label_1 has m1 and m2, but only m2 is in scope 2000
      expect(counts["Label_1"].own).toBe(1);
    });

    it("narrowing scope within cache depth doesn't trigger per-label API calls", async () => {
      // Initial build with a 3-year scope sets cacheDepth
      mockApi.fetchLabels.mockResolvedValue(scopeLabels);
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2", "m3"];
        if (labelId === "SENT") return ["m2", "m3"];
        if (labelId === "Label_1") return ["m1", "m2"];
        if (labelId === "Label_2") return ["m3"];
        return [];
      });

      const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
      const threeYearsAgoMidnight = new Date(threeYearsAgo); threeYearsAgoMidnight.setHours(0, 0, 0, 0);
      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/", threeYearsAgo);

      // Stop background expansion so it doesn't interfere with scope test
      mgr.abort();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify cacheDepth was set (normalized to midnight)
      const cacheDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(cacheDepth.timestamp).toBe(threeYearsAgoMidnight.getTime());

      // Clear call counts from initial build
      mockApi.fetchLabelMessageIds.mockClear();
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);

      // Narrow scope to 1 year (within cache depth of 3 years)
      const oneYearAgo = Date.now() - 1 * 365 * 24 * 60 * 60 * 1000;
      await mgr.setScopeFilter(oneYearAgo);

      // fetchScopedMessageIds should have been called (one API call for the scoped ID set)
      expect(mockApi.fetchScopedMessageIds).toHaveBeenCalledTimes(1);
      // fetchLabelMessageIds should NOT have been called (no per-label API calls)
      expect(mockApi.fetchLabelMessageIds).not.toHaveBeenCalled();

      // Verify results are correctly filtered
      const counts = await mgr.getLabelCounts();
      expect(counts["INBOX"].own).toBe(2); // m2, m3
      expect(counts["Label_1"].own).toBe(1); // m2
      expect(counts["Label_2"].own).toBe(1); // m3
    });

    it("multi-window: clearScopeState preserves cached scoped ID sets for reuse", async () => {
      manager.setLabels(scopeLabels);
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);
      await manager.setScopeFilter(2000);

      manager.clearScopeState();

      // After clear, the per-timestamp scoped ID set cache is preserved —
      // expectedScope=2000 still filters via the cached set (no redundant API call)
      const result = await manager.queryLabel("INBOX", false, 2000);
      expect(result.count).toBe(2); // m2, m3 — filtered via cached scoped ID set
    });
  });

  describe("gap-fill (widening scope)", () => {
    const scopeLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];

    it("widening scope triggers per-label gap-fill for missing segment only", async () => {
      // Initial build with 3-year scope
      mockApi.fetchLabels.mockResolvedValue(scopeLabels);
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m2"];
        return [];
      });

      const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
      const threeYearsAgoMidnight = new Date(threeYearsAgo); threeYearsAgoMidnight.setHours(0, 0, 0, 0);
      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/", threeYearsAgo);

      // Stop background expansion so it doesn't interfere with gap-fill assertions
      mgr.abort();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify cacheDepth (normalized to midnight)
      const cacheDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(cacheDepth.timestamp).toBe(threeYearsAgoMidnight.getTime());

      // Clear mocks from initial build
      mockApi.fetchLabelMessageIds.mockClear();

      // Gap-fill will return new older messages
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m10"]);
      // Scoped IDs for the 5-year scope
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m1", "m2", "m10"]);

      const progressUpdates: CacheProgress[] = [];
      mgr.setProgressCallback(p => progressUpdates.push({ ...p }));

      // Widen scope to 5 years
      const fiveYearsAgo = Date.now() - 5 * 365 * 24 * 60 * 60 * 1000;
      const fiveYearsAgoMidnight = new Date(fiveYearsAgo); fiveYearsAgoMidnight.setHours(0, 0, 0, 0);
      await mgr.setScopeFilter(fiveYearsAgo);

      // Wait for background gap-fill to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // fetchLabelMessageIds should have been called with afterDate and beforeDate for gap-fill
      const gapFillCalls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(gapFillCalls.length).toBe(scopeLabels.length); // one per label
      for (const call of gapFillCalls) {
        // afterDate = 5 years ago, beforeDate = 3 years ago
        expect(call[1]).toBeDefined(); // afterDate (scopeDate param)
        expect(call[2]).toBeDefined(); // beforeDate
      }

      // cacheDepth should be updated to the wider scope (normalized to midnight)
      const newDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(newDepth.timestamp).toBe(fiveYearsAgoMidnight.getTime());

      // New messages should be merged into label indexes
      const inboxIdx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(inboxIdx).toContain("m10");
      expect(inboxIdx).toContain("m1");
      expect(inboxIdx).toContain("m2");

      // Progress should include "expanding" phase
      const expandingUpdates = progressUpdates.filter(p => p.phase === "expanding");
      expect(expandingUpdates.length).toBeGreaterThan(0);
    });

    it("'any' scope from partial cache triggers backward fill", async () => {
      // Initial build with 3-year scope
      mockApi.fetchLabels.mockResolvedValue(scopeLabels);
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m2"];
        return [];
      });

      const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/", threeYearsAgo);

      // Stop background expansion so it doesn't interfere
      mgr.abort();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Clear mocks
      mockApi.fetchLabelMessageIds.mockClear();
      // Gap-fill returns older messages
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m20"]);

      // Select "any" scope (null)
      await mgr.setScopeFilter(null);

      // Wait for background gap-fill
      await new Promise(resolve => setTimeout(resolve, 50));

      // fetchLabelMessageIds should be called with no afterDate but with beforeDate
      const gapFillCalls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(gapFillCalls.length).toBe(scopeLabels.length);
      for (const call of gapFillCalls) {
        expect(call[1]).toBeUndefined(); // no afterDate (fetch all older)
        expect(call[2]).toBeDefined(); // beforeDate = cacheDepth date
      }

      // cacheDepth should become null (full coverage)
      const newDepth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(newDepth.timestamp).toBeNull();
    });

    it("cacheDepth updated after gap-fill completes", async () => {
      // Initial build with 1-year scope
      mockApi.fetchLabels.mockResolvedValue(scopeLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const oneYearAgoMidnight = new Date(oneYearAgo); oneYearAgoMidnight.setHours(0, 0, 0, 0);
      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/", oneYearAgo);

      // Stop background expansion so it doesn't interfere
      mgr.abort();
      await new Promise(resolve => setTimeout(resolve, 10));

      let depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(depth.timestamp).toBe(oneYearAgoMidnight.getTime());

      // Widen to 3 years
      mockApi.fetchLabelMessageIds.mockClear();
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);
      mockApi.fetchScopedMessageIds.mockResolvedValue([]);

      const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
      const threeYearsAgoMidnight = new Date(threeYearsAgo); threeYearsAgoMidnight.setHours(0, 0, 0, 0);
      await mgr.setScopeFilter(threeYearsAgo);
      await new Promise(resolve => setTimeout(resolve, 50));

      depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(depth.timestamp).toBe(threeYearsAgoMidnight.getTime());

      // Widen to "any"
      mockApi.fetchLabelMessageIds.mockClear();
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);
      await mgr.setScopeFilter(null);
      await new Promise(resolve => setTimeout(resolve, 50));

      depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(depth.timestamp).toBeNull();
    });
  });

  describe("incremental refresh", () => {
    const refreshLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];

    it("fetches only new messages since lastFetchTimestamp", async () => {
      // Simulate a previous completed fetch
      const lastFetch = Date.now() - 60 * 60 * 1000; // 1 hour ago
      mockDb._meta.set("fetchState", { phase: "complete", lastFetchTimestamp: lastFetch });
      mockDb._meta.set("account", "/mail/u/0/");
      mockDb._meta.set("cacheDepth", { timestamp: null }); // full coverage
      // Existing label indexes
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:SENT", ["m2"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);

      mockApi.fetchLabels.mockResolvedValue(refreshLabels);
      // Incremental refresh returns new messages only
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m3"]);

      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/");

      // fetchLabelMessageIds should be called with after:date (from lastFetchTimestamp) and no beforeDate
      const calls = mockApi.fetchLabelMessageIds.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // All labels had existing indexes, so all should use the incremental scope date
        expect(call[1]).toBeDefined(); // afterDate from lastFetchTimestamp
        expect(call[1]).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
        expect(call[2]).toBeUndefined(); // no beforeDate
      }

      // New messages merged into existing indexes
      const inboxIdx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(inboxIdx).toContain("m1");
      expect(inboxIdx).toContain("m2");
      expect(inboxIdx).toContain("m3");
    });

    it("does not regress cache depth on incremental refresh", async () => {
      const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
      const lastFetch = Date.now() - 60 * 60 * 1000;
      mockDb._meta.set("fetchState", { phase: "complete", lastFetchTimestamp: lastFetch });
      mockDb._meta.set("account", "/mail/u/0/");
      mockDb._meta.set("cacheDepth", { timestamp: threeYearsAgo });
      mockDb._meta.set("labelIdx:INBOX", ["m1"]);
      mockDb._meta.set("labelIdx:SENT", ["m1"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);

      mockApi.fetchLabels.mockResolvedValue(refreshLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);

      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/");

      // Stop background expansion so it doesn't leak into subsequent tests
      mgr.abort();

      // cacheDepth should remain at threeYearsAgo, not be overwritten
      const depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(depth.timestamp).toBe(threeYearsAgo);
    });
  });

  describe("background expansion", () => {
    const expandLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];

    it("deepens cache progressively after initial build", async () => {
      mockApi.fetchLabels.mockResolvedValue(expandLabels);
      // Initial build returns some messages
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m1"]);

      // Use a 1-week scope so there are many expansion tiers to go through.
      // Normalize to midnight to match production behavior (scopeToTimestamp normalizes to start-of-day).
      const normalizeToMidnight = (ts: number): number => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
      const oneWeekAgo = normalizeToMidnight(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const twoWeeksAgo = normalizeToMidnight(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const mgr = new CacheManager();

      // Track cacheDepth values written during expansion
      const depthHistory: (number | null)[] = [];
      const baseSetMeta = (key: string, value: unknown) => { mockDb._meta.set(key, value); };
      mockDb.setMeta.mockImplementation(async (key: string, value: unknown) => {
        if (key === "cacheDepth") depthHistory.push((value as { timestamp: number | null }).timestamp);
        baseSetMeta(key, value);
      });

      const progressUpdates: CacheProgress[] = [];
      mgr.setProgressCallback(p => progressUpdates.push({ ...p }));

      await mgr.startFetch("/mail/u/0/", oneWeekAgo);

      // Wait for background expansion to run (it's async)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Abort to stop expansion so it doesn't leak into subsequent tests
      mgr.abort();

      // cacheDepth should have been expanded beyond the initial 1-week scope
      const depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      // Should reach full coverage (null) after walking through all tiers
      expect(depth.timestamp).toBeNull();

      // Verify progressive stepping: first depth is the initial scope (oneWeekAgo),
      // subsequent depths form a monotonically decreasing sequence ending with null
      expect(depthHistory.length).toBeGreaterThan(2);
      // First entry is the initial scope timestamp
      expect(depthHistory[0]).toBe(oneWeekAgo);
      // Second entry should be the next tier (2 weeks), not a distant jump (e.g. 5 years).
      // Allow 1 second of tolerance for Date.now() drift between test setup and startBackgroundExpansion.
      expect(depthHistory[1]).toBeLessThanOrEqual(twoWeeksAgo + 1000);
      expect(depthHistory[1]).toBeGreaterThan(twoWeeksAgo - 24 * 60 * 60 * 1000); // within 1 day of 2 weeks ago
      // All non-null entries should be monotonically decreasing (progressively older)
      for (let i = 1; i < depthHistory.length; i++) {
        if (depthHistory[i] === null) {
          expect(i).toBe(depthHistory.length - 1); // null should be last
        } else if (depthHistory[i - 1] !== null) {
          expect(depthHistory[i]!).toBeLessThan(depthHistory[i - 1]!);
        }
      }

      // fetchLabelMessageIds should have been called many times — initial build + expansion tiers
      const totalCalls = mockApi.fetchLabelMessageIds.mock.calls.length;
      // Initial build: 3 labels. Expansion: at least 3 more labels for the first tier
      expect(totalCalls).toBeGreaterThan(expandLabels.length);

      // Progress should include "expanding" phase from gap-fills
      const expandingUpdates = progressUpdates.filter(p => p.phase === "expanding");
      expect(expandingUpdates.length).toBeGreaterThan(0);
    });

    it("does not expand when cache already has full coverage", async () => {
      mockApi.fetchLabels.mockResolvedValue(expandLabels);
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m1"]);

      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/"); // no scope = full coverage

      await new Promise(resolve => setTimeout(resolve, 50));

      // cacheDepth should be null (full coverage from the start)
      const depth = mockDb._meta.get("cacheDepth") as { timestamp: number | null };
      expect(depth.timestamp).toBeNull();

      // Only the initial build calls, no expansion
      expect(mockApi.fetchLabelMessageIds.mock.calls.length).toBe(expandLabels.length);
    });

    it("is interrupted by a new fetch", async () => {
      mockApi.fetchLabels.mockResolvedValue(expandLabels);
      let firstExpansionCalls = 0;
      let interruptTriggered = false;
      mockApi.fetchLabelMessageIds.mockImplementation(async () => {
        if (!interruptTriggered) firstExpansionCalls++;
        // After initial build completes and first expansion call, start a new fetch
        if (firstExpansionCalls === expandLabels.length + 1 && !interruptTriggered) {
          interruptTriggered = true;
          // Don't await — just trigger to interrupt background expansion
          mgr.startFetch("/mail/u/0/");
        }
        return ["m1"];
      });

      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const mgr = new CacheManager();
      await mgr.startFetch("/mail/u/0/", oneWeekAgo);

      await new Promise(resolve => setTimeout(resolve, 100));
      mgr.abort();

      // First expansion should have been interrupted after at most one tier (3 labels).
      // Initial build = 3 calls, then expansion runs at most one tier before isStale stops it.
      // Without interruption, the first expansion alone would do 3 * 9 = 27 calls.
      expect(firstExpansionCalls).toBeLessThanOrEqual(expandLabels.length * 2);
    });
  });

  describe("cross-referencing", () => {
    it("correctly merges labels from multiple queries", async () => {
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      // Both queries return message "m1"
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1"];
        if (labelId === "Label_1") return ["m1"];
        return [];
      });


      await manager.startFetch("/mail/u/0/");

      const m1 = mockDb._store.get("m1")!;
      expect(m1.labelIds).toContain("INBOX");
      expect(m1.labelIds).toContain("Label_1");
      expect(m1.labelIds.length).toBe(2);
    });
  });

  describe("progress reporting", () => {
    it("emits progress for each label fetched", async () => {
      mockApi.fetchLabels.mockResolvedValue([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);


      const updates: CacheProgress[] = [];
      manager.setProgressCallback(p => updates.push({ ...p }));

      await manager.startFetch("/mail/u/0/");

      const labelUpdates = updates.filter(p => p.phase === "labels");
      // Initial + 2 labels = 3 updates in label phase
      expect(labelUpdates.length).toBe(3);
      expect(labelUpdates[0].labelsDone).toBe(0);
      expect(labelUpdates[1].labelsDone).toBe(1);
      expect(labelUpdates[2].labelsDone).toBe(2);
    });
  });
});
