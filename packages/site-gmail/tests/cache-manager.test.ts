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
      expect(mockApi.fetchLabelMessageIds).toHaveBeenCalledWith("Label_priority");
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

    it("multi-window: clearScopeState clears all cached scoped ID sets", async () => {
      manager.setLabels(scopeLabels);
      mockApi.fetchScopedMessageIds.mockResolvedValue(["m2", "m3"]);
      await manager.setScopeFilter(2000);

      manager.clearScopeState();

      // After clear, expectedScope=2000 should fall back to unscoped IndexedDB
      const result = await manager.queryLabel("INBOX", false, 2000);
      expect(result.count).toBe(3); // All messages — no cached scope available
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
