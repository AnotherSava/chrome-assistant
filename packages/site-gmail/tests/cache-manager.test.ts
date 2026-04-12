import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CacheManager, type CacheProgress, type FilterConfig, type OrchestratorAction, type ResultPush } from "../src/cache-manager.js";
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
  fetchLabelMessageIdsPage: vi.fn(),
  fetchScopedMessageIdsPage: vi.fn().mockResolvedValue({ ids: [], nextPageToken: null }),
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
  fetchLabelMessageIdsPage: ReturnType<typeof vi.fn>;
  fetchScopedMessageIdsPage: ReturnType<typeof vi.fn>;
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
    manager.stop();
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

  describe("queryLabel", () => {
    beforeEach(() => {
      // Set labels so co-label computation iterates over all labels
      manager.setLabels(testLabels);
      // Populate label indexes (co-labels are computed from index intersections)
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

    it("returns filtered results when scope is active", async () => {
      // Seed scoped ID set directly — only m2 and m4 are in scope
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(2500, new Set(["m2", "m4"]));

      const result = await manager.queryLabel("INBOX", false, 2500);
      expect(result.count).toBe(2); // m2 and m4 are in scoped INBOX index
    });

    it("returns empty result for unknown label", async () => {
      const result = await manager.queryLabel("NONEXISTENT", false);
      expect(result.count).toBe(0);
      expect(result.coLabelCounts).toEqual({});
    });

    it("returns empty for uncached label (orchestrator will fetch it later)", async () => {
      const result = await manager.queryLabel("Label_uncached", false);
      expect(result.count).toBe(0);
      expect(result.coLabelCounts).toEqual({});
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

      const mgr = new CacheManager();
      mgr.setLabels(hierarchyLabels);

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
      // Primary label excluded, descendants appear as co-labels
      expect(result.coLabelCounts).not.toHaveProperty("Label_1");
      expect(result.coLabelCounts).toHaveProperty("Label_2");
      expect(result.coLabelCounts).toHaveProperty("Label_3");
    });

    it("does not include descendants when includeChildren is false", async () => {
      const hierarchyLabels: GmailLabel[] = [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
        { id: "Label_2", name: "Work/Projects", type: "user" },
      ];

      const mgr = new CacheManager();
      mgr.setLabels(hierarchyLabels);

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

    function setupManagerWithLabels(labels: GmailLabel[]): CacheManager {
      const mgr = new CacheManager();
      mgr.setLabels(labels);
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

      const mgr = setupManagerWithLabels(hierarchyLabels);
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

      const mgr = setupManagerWithLabels(hierarchyLabels);
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

    it("filters counts by scope via scoped ID set", async () => {
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m3"]);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = setupManagerWithLabels(hierarchyLabels);
      // Seed scoped ID set — only m2 and m3 in scope
      (mgr as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(3000, new Set(["m2", "m3"]));
      const counts = await mgr.getLabelCounts(undefined, 3000);

      expect(counts["Label_1"].own).toBe(1); // m2 only
      expect(counts["Label_2"].own).toBe(1); // m3
      expect(counts["INBOX"].own).toBe(2); // m2, m3
    });

    it("omits labels with own=0 and inclusive=0 when scope is active", async () => {
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = setupManagerWithLabels(hierarchyLabels);
      // Seed scoped ID set — only m2 in scope
      (mgr as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(3000, new Set(["m2"]));
      const counts = await mgr.getLabelCounts(undefined, 3000);

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
      mockDb._meta.set("labelIdx:INBOX", []);
      mockDb._meta.set("labelIdx:SENT", []);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      mockDb._meta.set("labelIdx:Label_3", []);
      mockDb._meta.set("labelIdx:Label_4", []);

      const mgr = setupManagerWithLabels(hierarchyLabels);
      // Seed scoped ID set — only m2 in scope
      (mgr as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(3000, new Set(["m2"]));
      const counts = await mgr.getLabelCounts(undefined, 3000);

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

      const mgr = setupManagerWithLabels(hierarchyLabels);
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
    it("includes STARRED when showStarred is on", () => {
      const mgr = new CacheManager();
      mgr.setLabels([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);

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

    it("excludes STARRED when showStarred is off", () => {
      const mgr = new CacheManager();
      mgr.setLabels([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);

      mgr.updateSystemLabelSettings(false, false);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("INBOX");
      expect(ids).toContain("SENT");
      expect(ids).not.toContain("STARRED");
    });

    it("includes IMPORTANT when showImportant is on", () => {
      const mgr = new CacheManager();
      mgr.setLabels([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);

      mgr.updateSystemLabelSettings(false, true);
      const list = mgr.buildLabelQueryList();
      const ids = list.map(l => l.id);
      expect(ids).toContain("IMPORTANT");
      expect(ids).not.toContain("STARRED");
    });

    it("includes both STARRED and IMPORTANT when both settings are on", () => {
      const mgr = new CacheManager();
      mgr.setLabels([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "STARRED", name: "STARRED", type: "system" },
        { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
        { id: "Label_1", name: "Work", type: "user" },
      ]);

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

  describe("scope via scoped ID sets", () => {
    const scopeLabels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];

    beforeEach(() => {
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2", "m3"]);
      mockDb._meta.set("labelIdx:SENT", ["m2", "m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:Label_2", ["m3"]);
    });

    it("queryLabel with scope returns filtered results", async () => {
      manager.setLabels(scopeLabels);
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(2000, new Set(["m2", "m3"]));

      const result = await manager.queryLabel("INBOX", false, 2000);
      expect(result.count).toBe(2); // m2, m3 (m1 not in scope)
      expect(result.coLabelCounts["Label_1"]).toBe(1); // m2 only
      expect(result.coLabelCounts["Label_2"]).toBe(1); // m3 only
    });

    it("getLabelCounts with scope returns filtered counts", async () => {
      manager.setLabels(scopeLabels);
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(2500, new Set(["m3"]));

      const counts = await manager.getLabelCounts(undefined, 2500);
      expect(counts["INBOX"].own).toBe(1);
      expect(counts["SENT"].own).toBe(1);
      expect(counts["Label_2"].own).toBe(1);
      expect(counts).not.toHaveProperty("Label_1");
    });

    it("null scope reads from IndexedDB directly", async () => {
      manager.setLabels(scopeLabels);
      const result = await manager.queryLabel("INBOX", false, null);
      expect(result.count).toBe(3); // All three messages from IndexedDB label index
    });

    it("multi-window: different scopes return correct filtered results", async () => {
      manager.setLabels(scopeLabels);
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(2000, new Set(["m2", "m3"]));
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(3000, new Set(["m3"]));

      const result2000 = await manager.queryLabel("INBOX", false, 2000);
      expect(result2000.count).toBe(2);

      const result3000 = await manager.queryLabel("INBOX", false, 3000);
      expect(result3000.count).toBe(1);

      const counts2000 = await manager.getLabelCounts(undefined, 2000);
      expect(counts2000["INBOX"].own).toBe(2);
      expect(counts2000["Label_1"].own).toBe(1);
    });

    it("clearing scopedIdSets invalidates cached scoped ID sets", async () => {
      manager.setLabels(scopeLabels);
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(2000, new Set(["m2", "m3"]));

      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.clear();

      // After clear, expectedScope=2000 falls through to unscoped DB read
      const result = await manager.queryLabel("INBOX", false, 2000);
      expect(result.count).toBe(3); // m1, m2, m3 — unscoped
    });
  });


  describe("orchestrator decide()", () => {
    it("returns empty when labels not loaded", () => {
      const actions = manager.decide();
      expect(actions).toHaveLength(0);
    });

    it("returns fetch-label for initial cache build when no filter set", () => {
      manager.setLabels(testLabels);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide(1);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("fetch-label");
      expect(actions[0].labelId).toBe("INBOX");
    });

    it("returns fetch-label for selected label as priority 2", () => {
      manager.setLabels(testLabels);
      manager.setFilterConfig({ labelId: "Label_1", includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide(1);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("fetch-label");
      expect(actions[0].labelId).toBe("Label_1");
    });

    it("returns fetch-scope as priority 1 when scope timestamp set and not cached", () => {
      manager.setLabels(testLabels);
      manager.setFilterConfig({ labelId: "Label_1", includeChildren: false, scopeTimestamp: 1000 });
      const actions = manager.decide();
      // fetch-scope is priority 1, so it should come first
      expect(actions[0].type).toBe("fetch-scope");
      expect(actions[0].scopeDate).toBeDefined();
    });

    it("skips fetch-scope when scoped ID set already cached", () => {
      manager.setLabels(testLabels);
      // Manually seed the scoped ID set cache
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(1000, new Set(["m1"]));
      manager.setFilterConfig({ labelId: "Label_1", includeChildren: false, scopeTimestamp: 1000 });
      const actions = manager.decide();
      // Should skip scope and go to selected label
      expect(actions[0].type).toBe("fetch-label");
      expect(actions[0].labelId).toBe("Label_1");
    });

    it("skips processed labels in initial build", () => {
      manager.setLabels(testLabels);
      manager.markProcessed("INBOX");
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide();
      expect(actions[0].labelId).toBe("SENT");
    });

    it("returns empty when all labels processed and no scope needed", () => {
      manager.setLabels(testLabels);
      for (const l of testLabels) manager.markProcessed(l.id);
      manager.markProcessed("NONE");
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide();
      expect(actions).toHaveLength(0);
    });

    it("uses continuation page token for in-progress label fetch", () => {
      manager.setLabels(testLabels);
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });
      // Manually set a continuation for INBOX
      (manager as unknown as { continuations: Map<string, unknown> }).continuations.set("fetch-label:INBOX", { type: "fetch-label", labelId: "INBOX", nextPageToken: "token123" });
      const actions = manager.decide();
      expect(actions[0].type).toBe("fetch-label");
      expect(actions[0].labelId).toBe("INBOX");
      expect(actions[0].pageToken).toBe("token123");
    });

    it("uses continuation page token for in-progress scope fetch segment", () => {
      manager.setLabels(testLabels);
      const scopeTs = 1000;
      const scopeDate = (manager as unknown as { timestampToDateString: (ts: number) => string }).timestampToDateString(scopeTs);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: scopeTs });
      // Manually set a continuation and pending count for a scope segment
      (manager as unknown as { continuations: Map<string, unknown> }).continuations.set(`fetch-scope:${scopeTs}:0`, { type: "fetch-scope", nextPageToken: "scopeToken", scopeDate });
      (manager as unknown as { scopeSegmentsPending: Map<number, number> }).scopeSegmentsPending.set(scopeTs, 1);
      const actions = manager.decide(1);
      expect(actions[0].type).toBe("fetch-scope");
      expect(actions[0].pageToken).toBe("scopeToken");
    });

    it("enforces no two pages for same label with concurrency > 1", () => {
      manager.setLabels(testLabels);
      // Filter selects INBOX which is also first in initial build
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide(2);
      // Only one INBOX action, second action should be a different label
      const inboxActions = actions.filter(a => a.labelId === "INBOX");
      expect(inboxActions).toHaveLength(1);
      if (actions.length > 1) {
        expect(actions[1].labelId).not.toBe("INBOX");
        expect(actions[1].labelId).toBe("SENT");
      }
    });

    it("returns multiple actions for different labels with concurrency > 1", () => {
      manager.setLabels(testLabels);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide(3);
      expect(actions.length).toBe(3);
      const labelIds = actions.map(a => a.labelId);
      expect(new Set(labelIds).size).toBe(3); // all different labels
    });

    it("fetch-label does not include scopeDate even when scope timestamp set", () => {
      manager.setLabels(testLabels);
      // Seed scoped IDs so scope fetch is skipped
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(5000, new Set());
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: 5000 });
      const actions = manager.decide();
      expect(actions[0].type).toBe("fetch-label");
      expect(actions[0].scopeDate).toBeUndefined();
    });

    it("clears stale scope continuation when scope timestamp changes", () => {
      manager.setLabels(testLabels);
      // Use timestamps far enough apart to produce different date strings
      const oldTs = new Date("2024-01-15").getTime();
      const newTs = new Date("2024-06-15").getTime();
      const oldScopeDate = (manager as unknown as { timestampToDateString: (ts: number) => string }).timestampToDateString(oldTs);
      (manager as unknown as { continuations: Map<string, unknown> }).continuations.set("fetch-scope:", { type: "fetch-scope", nextPageToken: "oldToken", scopeDate: oldScopeDate });
      // Change to different scope
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: newTs });
      const actions = manager.decide();
      expect(actions[0].type).toBe("fetch-scope");
      expect(actions[0].pageToken).toBeUndefined(); // stale continuation cleared
    });

    it("fetches requested scope from multi-window ports when filterConfig scope is already cached", () => {
      manager.setLabels(testLabels);
      const filterScopeTs = 1000;
      const requestedTs = 2000;
      // Seed filterConfig scope as already cached
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(filterScopeTs, new Set(["m1"]));
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: filterScopeTs });
      // Request a different scope (simulating a second window)
      manager.requestScopeFetch(requestedTs);
      const actions = manager.decide();
      expect(actions[0].type).toBe("fetch-scope");
      expect(actions[0].scopeTimestamp).toBe(requestedTs);
    });

    it("requestScopeFetch is no-op when scope already cached", () => {
      manager.setLabels(testLabels);
      const ts = 3000;
      (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets.set(ts, new Set(["m1"]));
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: ts });
      manager.requestScopeFetch(ts);
      const actions = manager.decide();
      // No fetch-scope action since both filterConfig scope and requested scope are cached
      expect(actions.every(a => a.type !== "fetch-scope")).toBe(true);
    });
  });

  describe("orchestrator executeAction()", () => {
    beforeEach(() => {
      manager.setLabels(testLabels);
    });

    it("fetch-label stores results and marks processed on last page", async () => {
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1", "m2"], nextPageToken: null });
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });

      // Label should be marked as processed
      expect((manager as unknown as { processedLabels: Set<string> }).processedLabels.has("INBOX")).toBe(true);
      // Messages should be stored
      const idx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(idx).toEqual(["m1", "m2"]);
    });

    it("fetch-label creates continuation on intermediate page", async () => {
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: "page2" });
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });

      // Should NOT be marked as processed
      expect((manager as unknown as { processedLabels: Set<string> }).processedLabels.has("INBOX")).toBe(false);
      // Continuation should exist
      const conts = (manager as unknown as { continuations: Map<string, { nextPageToken: string }> }).continuations;
      expect(conts.get("fetch-label:INBOX")?.nextPageToken).toBe("page2");
    });

    it("fetch-label merges pages into existing index", async () => {
      // First page
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: "page2" });
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });
      // Second page
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m2"], nextPageToken: null });
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX", pageToken: "page2" });

      const idx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(idx).toContain("m1");
      expect(idx).toContain("m2");
    });

    it("fetch-scope accumulates IDs across pages and caches on completion", async () => {
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: 5000 });
      // First page
      mockApi.fetchScopedMessageIdsPage.mockResolvedValue({ ids: ["m1", "m2"], nextPageToken: "page2" });
      await manager.executeAction({ type: "fetch-scope", scopeDate: "1970/01/01" });
      // Should have continuation
      const conts = (manager as unknown as { continuations: Map<string, { nextPageToken: string }> }).continuations;
      expect(conts.has("fetch-scope:5000")).toBe(true);

      // Second page
      mockApi.fetchScopedMessageIdsPage.mockResolvedValue({ ids: ["m3"], nextPageToken: null });
      await manager.executeAction({ type: "fetch-scope", scopeDate: "1970/01/01", pageToken: "page2", scopeTimestamp: 5000 });

      // Scoped ID set should be cached
      const scopedIdSets = (manager as unknown as { scopedIdSets: Map<number, Set<string>> }).scopedIdSets;
      expect(scopedIdSets.has(5000)).toBe(true);
      expect(scopedIdSets.get(5000)!.size).toBe(3);
      // Continuation should be cleared
      expect(conts.has("fetch-scope:5000")).toBe(false);
    });

    it("fetch-label calls API without scopeDate or beforeDate", async () => {
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: [], nextPageToken: null });
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });
      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenCalledWith("INBOX", undefined);
    });
  });

  describe("orchestrator loop", () => {
    afterEach(() => {
      manager.stop();
    });

    it("processes all labels then sleeps", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: null });

      const startPromise = manager.start();
      // Wait for loop to process and sleep
      await new Promise(r => setTimeout(r, 50));
      manager.stop();
      await startPromise;

      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenCalledTimes(2);
      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenCalledWith("INBOX", undefined);
      expect((manager as unknown as { processedLabels: Set<string> }).processedLabels.has("INBOX")).toBe(true);
    });

    it("second start() stops previous loop and restarts", async () => {
      mockApi.fetchLabels.mockResolvedValue([]);
      const p1 = manager.start();
      await new Promise(r => setTimeout(r, 20));
      // Second start stops the first loop and starts a new one
      const p2 = manager.start();
      await new Promise(r => setTimeout(r, 20));
      manager.stop();
      await p1;
      await p2;
      // fetchLabels called twice — once per start
      expect(mockApi.fetchLabels).toHaveBeenCalledTimes(2);
    });

    it("wakes from sleep when setFilterConfig is called", async () => {
      // Start with all labels processed so loop sleeps
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      manager.markProcessed("INBOX");
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m10"], nextPageToken: null });

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 20)); // loop should be sleeping

      // Add a new unprocessed label by changing filter to an uncached label
      manager.setLabels([...singleLabel, { id: "Label_1", name: "Work", type: "user" }]);
      manager.setFilterConfig({ labelId: "Label_1", includeChildren: false, scopeTimestamp: null });

      await new Promise(r => setTimeout(r, 50));
      manager.stop();
      await startPromise;

      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenCalledWith("Label_1", undefined);
    });

    it("handles priority change mid-pagination", async () => {
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      let inboxCalls = 0;
      mockApi.fetchLabelMessageIdsPage.mockImplementation(async (labelId: string) => {
        if (labelId === "INBOX") {
          inboxCalls++;
          if (inboxCalls === 1) {
            // During first INBOX page, change filter to prioritize Label_1
            manager.setFilterConfig({ labelId: "Label_1", includeChildren: false, scopeTimestamp: null });
            return { ids: ["m1"], nextPageToken: "page2" };
          }
          return { ids: ["m2"], nextPageToken: null };
        }
        return { ids: ["m3"], nextPageToken: null };
      });

      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });
      const startPromise = manager.start();

      await new Promise(r => setTimeout(r, 100));
      manager.stop();
      await startPromise;

      // Label_1 should have been fetched (priority 2 after filter change)
      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenCalledWith("Label_1", undefined);
    });

    it("multi-page fetch uses continuation tokens", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      manager.markProcessed("NONE");
      let callCount = 0;
      mockApi.fetchLabelMessageIdsPage.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { ids: ["m1"], nextPageToken: "page2" };
        if (callCount === 2) return { ids: ["m2"], nextPageToken: "page3" };
        return { ids: ["m3"], nextPageToken: null };
      });

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 100));
      manager.stop();
      await startPromise;

      expect(callCount).toBe(3);
      // Second call should use page token from first
      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenNthCalledWith(2, "INBOX", "page2");
      expect(mockApi.fetchLabelMessageIdsPage).toHaveBeenNthCalledWith(3, "INBOX", "page3");
    });
  });

  describe("orchestrator setFilterConfig()", () => {
    it("stores config and it is retrievable", () => {
      const config: FilterConfig = { labelId: "INBOX", includeChildren: true, scopeTimestamp: 5000 };
      manager.setFilterConfig(config);
      expect(manager.getFilterConfig()).toEqual(config);
    });

    it("makes a defensive copy", () => {
      const config: FilterConfig = { labelId: "INBOX", includeChildren: false, scopeTimestamp: null };
      manager.setFilterConfig(config);
      config.labelId = "SENT"; // mutate original
      expect(manager.getFilterConfig().labelId).toBe("INBOX");
    });
  });


  describe("orchestrator refresh-label", () => {
    beforeEach(() => {
      manager.setLabels(testLabels);
      for (const l of testLabels) manager.markProcessed(l.id);
      manager.markProcessed("NONE");
    });

    it("decide returns refresh-label when cache is stale", () => {
      manager.setCacheDepthTimestamp(null); // full coverage
      const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
      manager.setLastRefreshTimestamp(twentyMinutesAgo);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide(1);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("refresh-label");
      expect(actions[0].labelId).toBe("INBOX");
      expect(actions[0].scopeDate).toBeDefined();
    });

    it("decide does not return refresh-label when cache is fresh", () => {
      manager.setCacheDepthTimestamp(null);
      manager.setLastRefreshTimestamp(Date.now() - 5 * 60 * 1000); // 5 min ago
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide();
      expect(actions).toHaveLength(0);
    });

    it("decide returns refresh-label when depth is partial and cache is stale", () => {
      const oneWeekAgo = new Date("2026-04-01").getTime();
      manager.setCacheDepthTimestamp(oneWeekAgo); // partial depth
      manager.setLastRefreshTimestamp(Date.now() - 20 * 60 * 1000); // stale
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });
      const actions = manager.decide();
      expect(actions[0].type).toBe("refresh-label");
    });

    it("executeAction refresh-label stores results and updates lastRefreshTimestamp when all done", async () => {
      manager.setCacheDepthTimestamp(null);
      const oldTimestamp = Date.now() - 20 * 60 * 1000;
      manager.setLastRefreshTimestamp(oldTimestamp);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });

      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m30"], nextPageToken: null });
      const allLabels = [...testLabels, { id: "NONE", name: "No user labels", type: "system" }];
      for (const label of allLabels) {
        await manager.executeAction({ type: "refresh-label", labelId: label.id, scopeDate: "2026/04/07" });
      }

      // lastRefreshTimestamp should be updated
      expect(manager.getLastRefreshTimestamp()).toBeGreaterThan(oldTimestamp);
      // fetchState should be updated in IndexedDB
      const fetchState = mockDb._meta.get("fetchState") as { phase: string; lastFetchTimestamp: number };
      expect(fetchState.phase).toBe("complete");
      expect(fetchState.lastFetchTimestamp).toBeGreaterThan(oldTimestamp);
      // Messages should be stored
      const idx = mockDb._meta.get("labelIdx:INBOX") as string[];
      expect(idx).toContain("m30");
    });

    it("executeAction refresh-label creates continuation on intermediate page", async () => {
      manager.setCacheDepthTimestamp(null);
      manager.setLastRefreshTimestamp(Date.now() - 20 * 60 * 1000);

      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m30"], nextPageToken: "refPage2" });
      await manager.executeAction({ type: "refresh-label", labelId: "INBOX", scopeDate: "2026/04/07" });

      const conts = (manager as unknown as { continuations: Map<string, { nextPageToken: string }> }).continuations;
      expect(conts.get("refresh-label:INBOX")?.nextPageToken).toBe("refPage2");
    });
  });

  describe("orchestrator initial build completion", () => {
    it("fetch-label sets cacheDepthTimestamp and lastRefreshTimestamp when all labels done", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      manager.setLabels(singleLabel);
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: null });

      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: null });
      manager.markProcessed("NONE");
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });

      expect(manager.getCacheDepthTimestamp()).toBeNull(); // null scope = full coverage
      expect(manager.getLastRefreshTimestamp()).toBeGreaterThan(0);
      const fetchState = mockDb._meta.get("fetchState") as { phase: string; lastFetchTimestamp: number };
      expect(fetchState.phase).toBe("complete");
    });

    it("fetch-label sets cacheDepthTimestamp to null (full coverage) when all labels done, even with scope set", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      manager.setLabels(singleLabel);
      const scopeTs = new Date("2025-04-08").getTime();
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: scopeTs });

      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: null });
      manager.markProcessed("NONE");
      await manager.executeAction({ type: "fetch-label", labelId: "INBOX" });

      expect(manager.getCacheDepthTimestamp()).toBeNull();
    });
  });

  describe("orchestrator progress reporting", () => {
    afterEach(() => {
      manager.stop();
    });

    it("emits labels progress during initial cache build", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: null });

      const updates: CacheProgress[] = [];
      manager.setProgressCallback(p => updates.push({ ...p }));

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 50));
      manager.stop();
      await startPromise;

      const labelUpdates = updates.filter(p => p.phase === "labels");
      expect(labelUpdates.length).toBeGreaterThanOrEqual(1);
      // After processing all labels, the final progress should reflect labelsTotal of 2 (INBOX + NONE)
      const lastLabelUpdate = labelUpdates[labelUpdates.length - 1];
      expect(lastLabelUpdate.labelsTotal).toBe(2);
      expect(lastLabelUpdate.labelsDone).toBeGreaterThanOrEqual(1);
    });

    it("emits scope progress during scope fetch", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      manager.markProcessed("INBOX");

      // Scope fetch with 2 pages
      let scopeCalls = 0;
      mockApi.fetchScopedMessageIdsPage.mockImplementation(async () => {
        scopeCalls++;
        if (scopeCalls === 1) return { ids: ["s1", "s2"], nextPageToken: "sp2" };
        return { ids: ["s3"], nextPageToken: null };
      });
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: [], nextPageToken: null });

      const updates: CacheProgress[] = [];
      manager.setProgressCallback(p => updates.push({ ...p }));

      const scopeTs = new Date("2025-06-01").getTime();
      manager.setFilterConfig({ labelId: null, includeChildren: false, scopeTimestamp: scopeTs });

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 100));
      manager.stop();
      await startPromise;

      const scopeUpdates = updates.filter(p => p.phase === "scope");
      expect(scopeUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it("emits complete when idle", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      manager.markProcessed("INBOX");
      manager.setLastRefreshTimestamp(Date.now());

      const updates: CacheProgress[] = [];
      manager.setProgressCallback(p => updates.push({ ...p }));

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 50));
      manager.stop();
      await startPromise;

      const completeUpdates = updates.filter(p => p.phase === "complete");
      expect(completeUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it("emits error on API failure and recovers", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);

      let callCount = 0;
      mockApi.fetchLabelMessageIdsPage.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("rate limit");
        return { ids: ["m1"], nextPageToken: null };
      });

      const updates: CacheProgress[] = [];
      manager.setProgressCallback(p => updates.push({ ...p }));

      const startPromise = manager.start();
      // Wait for error + backoff (1s) + retry + completion
      await new Promise(r => setTimeout(r, 1500));
      manager.stop();
      await startPromise;

      // Should have an error progress
      const errorUpdates = updates.filter(p => p.errorText);
      expect(errorUpdates.length).toBeGreaterThanOrEqual(1);
      expect(errorUpdates[0].errorText).toContain("rate limit");

      // Should have recovered and processed INBOX
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("result push callback", () => {
    beforeEach(() => {
      // Setup: pre-populate labels and label indexes so queryLabel/getLabelCounts work
      mockApi.fetchLabels.mockResolvedValue(testLabels);
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: [], nextPageToken: null });
    });

    it("setFilterConfig with cached data pushes immediately", async () => {
      // Pre-populate label indexes in DB
      mockDb._meta.set("labelIdx:INBOX", ["m1", "m2"]);
      mockDb._meta.set("labelIdx:SENT", ["m3"]);
      mockDb._meta.set("labelIdx:Label_1", ["m1"]);
      mockDb._meta.set("labelIdx:Label_2", ["m2"]);
      // Pre-populate messages for co-label counting
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX", "Label_1"] });
      mockDb._store.set("m2", { id: "m2", labelIds: ["INBOX", "Label_2"] });

      // Set labels on manager so queryLabel/getLabelCounts work
      (manager as unknown as { labels: GmailLabel[] }).labels = testLabels;
      // Mark initial build as complete so pushResults doesn't skip
      manager.setCacheDepthTimestamp(null);

      const pushes: ResultPush[] = [];
      manager.setResultCallback(r => pushes.push(r));

      // No scope needed — data is fully cached
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });

      // Wait for async pushResults to complete
      await new Promise(r => setTimeout(r, 50));

      expect(pushes.length).toBe(1);
      expect(pushes[0].labelId).toBe("INBOX");
      expect(pushes[0].count).toBe(2);
      expect(pushes[0].coLabelCounts).toEqual({ Label_1: 1, Label_2: 1 });
      expect(pushes[0].filterConfig).toEqual({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });
      // counts should include label counts
      expect(pushes[0].counts["INBOX"]).toEqual({ own: 2, inclusive: 2 });
    });

    it("setFilterConfig with missing scope does not push until scope is fetched", async () => {
      mockDb._meta.set("labelIdx:INBOX", ["m1"]);
      mockDb._store.set("m1", { id: "m1", labelIds: ["INBOX"] });
      (manager as unknown as { labels: GmailLabel[] }).labels = testLabels;
      manager.setCacheDepthTimestamp(null);

      const pushes: ResultPush[] = [];
      manager.setResultCallback(r => pushes.push(r));

      // Scope timestamp set but not cached — should NOT push
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: 1000 });
      await new Promise(r => setTimeout(r, 50));

      expect(pushes.length).toBe(0);
    });

    it("orchestrator pushes results after fetching a label", async () => {
      const singleLabel: GmailLabel[] = [{ id: "INBOX", name: "INBOX", type: "system" }];
      mockApi.fetchLabels.mockResolvedValue(singleLabel);
      mockApi.fetchLabelMessageIdsPage.mockResolvedValue({ ids: ["m1"], nextPageToken: null });

      const pushes: ResultPush[] = [];
      manager.setResultCallback(r => pushes.push(r));

      // Start orchestrator first, then set filter config so the orchestrator handles the fetch
      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 50));
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });
      await new Promise(r => setTimeout(r, 200));
      manager.stop();
      await startPromise;

      // Should have pushed at least once with real data (when INBOX label is indexed and it's the selected label)
      const inboxPushes = pushes.filter(p => p.labelId === "INBOX" && p.count > 0);
      expect(inboxPushes.length).toBeGreaterThanOrEqual(1);
      expect(inboxPushes[0].count).toBe(1);
      expect(inboxPushes[0].filterConfig.labelId).toBe("INBOX");
    });

    it("filter config change during fetch pushes new results not stale", async () => {
      const labels: GmailLabel[] = [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
      ];
      mockApi.fetchLabels.mockResolvedValue(labels);

      let fetchCount = 0;
      mockApi.fetchLabelMessageIdsPage.mockImplementation(async (labelId: string) => {
        fetchCount++;
        if (labelId === "INBOX") return { ids: ["m1"], nextPageToken: null };
        if (labelId === "SENT") return { ids: ["m2"], nextPageToken: null };
        return { ids: [], nextPageToken: null };
      });

      const pushes: ResultPush[] = [];
      manager.setResultCallback(r => pushes.push(r));
      manager.setFilterConfig({ labelId: "INBOX", includeChildren: false, scopeTimestamp: null });

      const startPromise = manager.start();
      await new Promise(r => setTimeout(r, 100));

      // Change filter config mid-stream
      manager.setFilterConfig({ labelId: "SENT", includeChildren: false, scopeTimestamp: null });
      await new Promise(r => setTimeout(r, 200));
      manager.stop();
      await startPromise;

      // The last push should have filterConfig pointing to SENT (the current config)
      const lastPush = pushes[pushes.length - 1];
      expect(lastPush.filterConfig.labelId).toBe("SENT");
    });
  });
});
