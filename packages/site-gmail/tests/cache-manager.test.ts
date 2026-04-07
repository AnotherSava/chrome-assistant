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
    getMessagesByLabel: vi.fn(async (labelId: string) => [...store.values()].filter(m => m.labelIds.includes(labelId))),
    getMeta: vi.fn(async (key: string) => meta.get(key)),
    setMeta: vi.fn(async (key: string, value: unknown) => { meta.set(key, value); }),
    getMessagesWithoutDates: vi.fn(async (batchSize: number = 100) => {
      const results: CacheMessage[] = [];
      for (const m of store.values()) {
        if (m.internalDate === null) results.push(m);
        if (results.length >= batchSize) break;
      }
      return results;
    }),
    clearAll: vi.fn(async () => { store.clear(); meta.clear(); }),
    getMessageCount: vi.fn(async () => store.size),
    countMessagesWithoutDates: vi.fn(async () => { let count = 0; for (const m of store.values()) { if (m.internalDate === null) count++; } return count; }),
    getFilteredLabelCounts: vi.fn(async (labelIds: string[], scopeTimestamp: number | null) => {
      const counts: Record<string, number> = {};
      for (const labelId of labelIds) {
        const msgIds = meta.get(`labelIdx:${labelId}`) as string[] | undefined;
        if (!msgIds || msgIds.length === 0) { counts[labelId] = 0; continue; }
        let count = 0;
        for (const id of msgIds) {
          const msg = store.get(id);
          if (!msg || msg.internalDate === 0) continue;
          if (scopeTimestamp !== null && (msg.internalDate === null || msg.internalDate < scopeTimestamp)) continue;
          count++;
        }
        counts[labelId] = count;
      }
      return counts;
    }),
    _store: store,
    _meta: meta,
  };
});

// Mock gmail-api
vi.mock("../src/gmail-api.js", () => ({
  fetchLabels: vi.fn(),
  fetchLabelMessageIds: vi.fn(),
  batchFetchDates: vi.fn(),
}));

import * as dbMock from "../src/cache-db.js";
import * as apiMock from "../src/gmail-api.js";

const mockDb = dbMock as unknown as {
  putMessages: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  getMessagesByLabel: ReturnType<typeof vi.fn>;
  getMeta: ReturnType<typeof vi.fn>;
  setMeta: ReturnType<typeof vi.fn>;
  getMessagesWithoutDates: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  getMessageCount: ReturnType<typeof vi.fn>;
  countMessagesWithoutDates: ReturnType<typeof vi.fn>;
  getFilteredLabelCounts: ReturnType<typeof vi.fn>;
  _store: Map<string, CacheMessage>;
  _meta: Map<string, unknown>;
};

const mockApi = apiMock as unknown as {
  fetchLabels: ReturnType<typeof vi.fn>;
  fetchLabelMessageIds: ReturnType<typeof vi.fn>;
  batchFetchDates: ReturnType<typeof vi.fn>;
};

const testLabels: GmailLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "Label_1", name: "Work", type: "user" },
  { id: "Label_2", name: "Personal", type: "user" },
];

describe("CacheManager", () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
    mockDb._store.clear();
    mockDb._meta.clear();
    vi.clearAllMocks();
    // Re-setup the default mock implementations after clearAllMocks
    mockDb.putMessages.mockImplementation(async (messages: CacheMessage[]) => { for (const m of messages) mockDb._store.set(m.id, m); });
    mockDb.getMessage.mockImplementation(async (id: string) => mockDb._store.get(id));
    mockDb.getMessagesByLabel.mockImplementation(async (labelId: string) => [...mockDb._store.values()].filter(m => m.labelIds.includes(labelId)));
    mockDb.getMeta.mockImplementation(async (key: string) => mockDb._meta.get(key));
    mockDb.setMeta.mockImplementation(async (key: string, value: unknown) => { mockDb._meta.set(key, value); });
    mockDb.getMessagesWithoutDates.mockImplementation(async (batchSize: number = 100) => {
      const results: CacheMessage[] = [];
      for (const m of mockDb._store.values()) {
        if (m.internalDate === null) results.push(m);
        if (results.length >= batchSize) break;
      }
      return results;
    });
    mockDb.clearAll.mockImplementation(async () => { mockDb._store.clear(); mockDb._meta.clear(); });
    mockDb.getMessageCount.mockImplementation(async () => mockDb._store.size);
    mockDb.countMessagesWithoutDates.mockImplementation(async () => { let count = 0; for (const m of mockDb._store.values()) { if (m.internalDate === null) count++; } return count; });
    mockDb.getFilteredLabelCounts.mockImplementation(async (labelIds: string[], scopeTimestamp: number | null) => {
      const counts: Record<string, number> = {};
      for (const labelId of labelIds) {
        const msgIds = mockDb._meta.get(`labelIdx:${labelId}`) as string[] | undefined;
        if (!msgIds || msgIds.length === 0) { counts[labelId] = 0; continue; }
        let count = 0;
        for (const id of msgIds) {
          const msg = mockDb._store.get(id);
          if (!msg || msg.internalDate === 0) continue;
          if (scopeTimestamp !== null && (msg.internalDate === null || msg.internalDate < scopeTimestamp)) continue;
          count++;
        }
        counts[labelId] = count;
      }
      return counts;
    });
  });

  describe("startFetch", () => {
    it("runs Phase 1 (label queries) and Phase 2 (date fetch)", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      // INBOX has messages m1, m2; SENT has m2, m3; Work has m1; Personal has m3
      mockApi.fetchLabelMessageIds.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") return ["m1", "m2"];
        if (labelId === "SENT") return ["m2", "m3"];
        if (labelId === "Label_1") return ["m1"];
        if (labelId === "Label_2") return ["m3"];
        return [];
      });
      mockApi.batchFetchDates.mockResolvedValue([
        { id: "m1", internalDate: 1000 },
        { id: "m2", internalDate: 2000 },
        { id: "m3", internalDate: 3000 },
      ]);

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

      // Verify dates were fetched
      expect(m1.internalDate).toBe(1000);
      expect(m2.internalDate).toBe(2000);
      expect(m3.internalDate).toBe(3000);

      // Verify progress includes label phase and date phase and complete
      const phases = progressUpdates.map(p => p.phase);
      expect(phases).toContain("labels");
      expect(phases).toContain("dates");
      expect(phases[phases.length - 1]).toBe("complete");

      // Verify fetchState was saved
      const fetchState = mockDb._meta.get("fetchState") as { phase: string; lastFetchTimestamp: number };
      expect(fetchState.phase).toBe("complete");
      expect(fetchState.lastFetchTimestamp).toBeGreaterThan(0);
    });

    it("clears cache on account change", async () => {
      mockDb._meta.set("account", "/mail/u/1/");
      mockDb._store.set("old", { id: "old", internalDate: 100, labelIds: ["INBOX"] });

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
      mockApi.batchFetchDates.mockResolvedValue([]);

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
      mockDb._store.set("m1", { id: "m1", internalDate: 1000, labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", internalDate: 2000, labelIds: ["INBOX", "SENT", "Label_1"] });
      mockDb._store.set("m3", { id: "m3", internalDate: 3000, labelIds: ["SENT", "Label_2"] });
      mockDb._store.set("m4", { id: "m4", internalDate: 4000, labelIds: ["INBOX", "Label_2"] });
      // Populate label index (mirrors what crossReferenceLabel stores)
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m4"]);
      mockDb._meta.set("labelIdx:SENT", ["m2", "m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3", "m4"]);
    });

    it("returns count and co-occurring labels for a label", async () => {
      const result = await manager.queryLabel(["INBOX"], null);
      expect(result.count).toBe(3); // m1, m2, m4
      expect(result.coLabelCounts).toHaveProperty("Label_1");
      expect(result.coLabelCounts).toHaveProperty("SENT");
      expect(result.coLabelCounts).toHaveProperty("Label_2");
    });

    it("returns all messages for a label without location filtering", async () => {
      const result = await manager.queryLabel(["Label_1"], null);
      expect(result.count).toBe(2); // m1, m2
    });

    it("filters by scope timestamp when all messages have dates", async () => {
      const result = await manager.queryLabel(["INBOX"], 2500);
      expect(result.count).toBe(1); // m4 (internalDate 4000 >= 2500)
    });

    it("uses scope fallback when some messages lack dates", async () => {
      mockDb._store.set("m5", { id: "m5", internalDate: null, labelIds: ["INBOX", "Label_1"] });
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m4", "m5"]);

      // Setup labels for the fallback
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      await (manager as any).labels.push(...testLabels);

      // The fallback calls fetchLabelMessageIds with a scope date
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m2", "m4"]);

      const result = await manager.queryLabel(["INBOX"], 2000);
      // Fallback returns count based on scoped API IDs cross-referenced with IndexedDB
      expect(result.count).toBe(2);
    });

    it("returns empty result for unknown label", async () => {
      mockApi.fetchLabelMessageIds.mockResolvedValue([]);
      const result = await manager.queryLabel(["NONEXISTENT"], null);
      expect(result.count).toBe(0);
      expect(result.coLabelCounts).toEqual({});
    });

    it("prioritizes uncached label when cache is still building", async () => {
      // Simulate cache in labels phase
      mockDb._meta.set("fetchState", { phase: "labels", lastFetchTimestamp: null });
      // The priority fetch will call fetchLabelMessageIds for the uncached label
      mockApi.fetchLabelMessageIds.mockResolvedValue(["m10", "m11"]);
      const result = await manager.queryLabel(["Label_priority"], null);
      expect(mockApi.fetchLabelMessageIds).toHaveBeenCalledWith("Label_priority");
      expect(result.count).toBe(2);
      // Messages should now be in the DB for subsequent queries
      const cached = await mockDb.getMessagesByLabel("Label_priority");
      expect(cached.length).toBe(2);
    });

    it("returns union count and combined co-labels for multiple label IDs", async () => {
      // Label_1 has m1, m2; Label_2 has m3, m4; m2 is shared via SENT
      const result = await manager.queryLabel(["Label_1", "Label_2"], null);
      expect(result.count).toBe(4); // m1, m2, m3, m4 (all unique)
      expect(result.labelId).toBe("Label_1"); // primary ID
      // Primary label (Label_1) should be excluded from co-label counts
      expect(result.coLabelCounts).not.toHaveProperty("Label_1");
      // Sub-label IDs (Label_2) should appear as co-label counts
      expect(result.coLabelCounts).toHaveProperty("Label_2");
      expect(result.coLabelCounts).toHaveProperty("INBOX");
      expect(result.coLabelCounts).toHaveProperty("SENT");
    });

    it("excludes only primary ID from co-labels, sub-label IDs appear if messages have them", async () => {
      // Add a message that has both Label_1 and Label_2
      mockDb._store.set("m5", { id: "m5", internalDate: 5000, labelIds: ["Label_1", "Label_2", "INBOX"] });
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2", "m5"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3", "m4", "m5"]);
      const result = await manager.queryLabel(["Label_1", "Label_2"], null);
      // Label_2 should appear as a co-label count (not excluded)
      expect(result.coLabelCounts).toHaveProperty("Label_2");
      // Label_1 (primary) should not appear
      expect(result.coLabelCounts).not.toHaveProperty("Label_1");
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
      mockApi.batchFetchDates.mockResolvedValue([]);
      await mgr.startFetch("/mail/u/0/");
      return mgr;
    }

    it("returns correct own counts per label", async () => {
      mockDb._store.set("m1", { id: "m1", internalDate: 1000, labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", internalDate: 2000, labelIds: ["INBOX", "Label_1", "Label_2"] });
      mockDb._store.set("m3", { id: "m3", internalDate: 3000, labelIds: ["SENT", "Label_4"] });
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:SENT", ["m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", ["m3"]);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts(null);

      expect(counts["INBOX"].own).toBe(2);
      expect(counts["SENT"].own).toBe(1);
      expect(counts["Label_1"].own).toBe(2);
      expect(counts["Label_2"].own).toBe(1);
      expect(counts["Label_3"].own).toBe(0);
      expect(counts["Label_4"].own).toBe(1);
    });

    it("returns correct inclusive counts for parent labels (deduplicated)", async () => {
      // m1: Work only, m2: Work + Work/Projects, m3: Work/Projects/Alpha only
      mockDb._store.set("m1", { id: "m1", internalDate: 1000, labelIds: ["Label_1"] });
      mockDb._store.set("m2", { id: "m2", internalDate: 2000, labelIds: ["Label_1", "Label_2"] });
      mockDb._store.set("m3", { id: "m3", internalDate: 3000, labelIds: ["Label_3"] });
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", ["m3"]);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts(null);

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

    it("filters counts by scope timestamp", async () => {
      mockDb._store.set("m1", { id: "m1", internalDate: 1000, labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", internalDate: 5000, labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m3", { id: "m3", internalDate: 8000, labelIds: ["INBOX", "Label_2"] });
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m3"]);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = await setupManagerWithLabels(hierarchyLabels);
      const counts = await mgr.getLabelCounts(3000);

      // Only messages with internalDate >= 3000: m2 (5000), m3 (8000)
      expect(counts["Label_1"].own).toBe(1); // m2 only
      expect(counts["Label_2"].own).toBe(1); // m3
      expect(counts["INBOX"].own).toBe(2); // m2, m3
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
      mockApi.batchFetchDates.mockResolvedValue([]);
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
      mockApi.batchFetchDates.mockResolvedValue([]);
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
      mockApi.batchFetchDates.mockResolvedValue([]);
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
      mockApi.batchFetchDates.mockResolvedValue([]);
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
      mockApi.batchFetchDates.mockResolvedValue([{ id: "m1", internalDate: 5000 }]);

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
      mockApi.batchFetchDates.mockResolvedValue([]);

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
