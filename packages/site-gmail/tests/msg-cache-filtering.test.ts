import { describe, it, expect, beforeEach, vi } from "vitest";
import { mergeMessages, getMsgCache, resetMsgCache, loadMsgCache, saveMsgCache, filterMessages, deriveRelevantLabelIds, addParentChain, isCacheCovering, clearLabelOldest } from "../src/msg-cache.js";
import type { MessageMeta } from "@core/types.js";

const store = new Map<string, unknown>();

vi.mock("@core/settings.js", () => ({
  loadSetting: (key: string, defaultVal: unknown) => {
    return store.has(key) ? store.get(key) : defaultVal;
  },
  saveSetting: (key: string, value: unknown) => {
    store.set(key, value);
  },
}));

function seedCache(messages: MessageMeta[]): void {
  mergeMessages(messages);
}

describe("loadMsgCache account scoping", () => {
  beforeEach(() => {
    resetMsgCache();
    store.clear();
  });

  it("loads cache normally when account matches", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    saveMsgCache("/mail/u/0/");
    resetMsgCache();
    loadMsgCache("/mail/u/0/");
    expect(getMsgCache().messages).toHaveLength(1);
  });

  it("resets cache when persisted account differs from current", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    saveMsgCache("/mail/u/0/");
    resetMsgCache();
    loadMsgCache("/mail/u/1/");
    expect(getMsgCache().messages).toHaveLength(0);
    expect(getMsgCache().oldest).toBeNull();
  });

  it("discards cache when no account was previously stored (legacy migration)", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    saveMsgCache(); // no account path — simulates pre-account-scoping cache
    resetMsgCache();
    loadMsgCache("/mail/u/0/");
    expect(getMsgCache().messages).toHaveLength(0);
    expect(getMsgCache().oldest).toBeNull();
  });

  it("loads cache when no account path is provided to loadMsgCache", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    saveMsgCache("/mail/u/0/");
    resetMsgCache();
    loadMsgCache(); // no account path — legacy behavior
    expect(getMsgCache().messages).toHaveLength(1);
  });
});

describe("filterMessages", () => {
  beforeEach(() => {
    resetMsgCache();
    store.clear();
  });

  it("returns all messages when location=all, no scope, no label", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["SENT", "Label_2"], internalDate: 1700100000000 },
    ]);
    const result = filterMessages("all", null, null);
    expect(result).toHaveLength(2);
  });

  it("filters by inbox location", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["SENT", "Label_2"], internalDate: 1700100000000 },
      { id: "m3", labelIds: ["INBOX", "SENT"], internalDate: 1700200000000 },
    ]);
    const result = filterMessages("inbox", null, null);
    expect(result).toHaveLength(2);
  });

  it("filters by sent location", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["SENT", "Label_2"], internalDate: 1700100000000 },
    ]);
    const result = filterMessages("sent", null, null);
    expect(result).toHaveLength(1);
  });

  it("filters by scope timestamp", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX"], internalDate: 1700100000000 },
      { id: "m3", labelIds: ["INBOX"], internalDate: 1700200000000 },
    ]);
    const result = filterMessages("all", 1700100000000, null);
    expect(result).toHaveLength(2);
  });

  it("filters by label (co-occurrence mode)", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_2"], internalDate: 1700100000000 },
      { id: "m3", labelIds: ["INBOX", "Label_1", "Label_2"], internalDate: 1700200000000 },
    ]);
    const result = filterMessages("inbox", null, "Label_1");
    expect(result).toHaveLength(2);
  });

  it("combines location, scope, and label filters", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_1"], internalDate: 1700200000000 },
      { id: "m3", labelIds: ["SENT", "Label_1"], internalDate: 1700200000000 },
      { id: "m4", labelIds: ["INBOX", "Label_2"], internalDate: 1700200000000 },
    ]);
    const result = filterMessages("inbox", 1700100000000, "Label_1");
    expect(result).toHaveLength(1);
    expect(result[0][0]).toBe(1700200000000);
  });

  it("returns empty when no messages match", () => {
    seedCache([
      { id: "m1", labelIds: ["SENT"], internalDate: 1700000000000 },
    ]);
    const result = filterMessages("inbox", null, null);
    expect(result).toHaveLength(0);
  });

  it("returns empty when label not in index", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
    ]);
    const result = filterMessages("all", null, "NonExistent");
    expect(result).toHaveLength(0);
  });
});

describe("deriveRelevantLabelIds", () => {
  beforeEach(() => {
    resetMsgCache();
    store.clear();
  });

  it("returns all label IDs from filtered messages", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1", "Label_2"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_3"], internalDate: 1700100000000 },
    ]);
    const filtered = filterMessages("all", null, null);
    const ids = deriveRelevantLabelIds(filtered);
    expect(ids).toEqual(new Set(["INBOX", "Label_1", "Label_2", "Label_3"]));
  });

  it("returns empty set for empty input", () => {
    const ids = deriveRelevantLabelIds([]);
    expect(ids.size).toBe(0);
  });

  it("handles messages with no labels", () => {
    seedCache([
      { id: "m1", labelIds: [], internalDate: 1700000000000 },
    ]);
    const filtered = filterMessages("all", null, null);
    const ids = deriveRelevantLabelIds(filtered);
    expect(ids.size).toBe(0);
  });
});

describe("addParentChain", () => {
  const allLabels = [
    { id: "id_a", name: "A" },
    { id: "id_ab", name: "A/B" },
    { id: "id_abc", name: "A/B/C" },
    { id: "id_d", name: "D" },
    { id: "id_de", name: "D/E" },
  ];

  it("adds parent labels for nested relevant labels", () => {
    const relevant = new Set(["id_abc"]);
    const result = addParentChain(relevant, allLabels);
    expect(result).toContain("id_a");
    expect(result).toContain("id_ab");
    expect(result).toContain("id_abc");
  });

  it("does not add unrelated labels", () => {
    const relevant = new Set(["id_abc"]);
    const result = addParentChain(relevant, allLabels);
    expect(result).not.toContain("id_d");
    expect(result).not.toContain("id_de");
  });

  it("handles flat labels (no parents)", () => {
    const relevant = new Set(["id_d"]);
    const result = addParentChain(relevant, allLabels);
    expect(result).toEqual(new Set(["id_d"]));
  });

  it("preserves existing relevant IDs", () => {
    const relevant = new Set(["id_a", "id_abc"]);
    const result = addParentChain(relevant, allLabels);
    expect(result).toContain("id_a");
    expect(result).toContain("id_ab");
    expect(result).toContain("id_abc");
  });

  it("handles unknown label IDs gracefully", () => {
    const relevant = new Set(["unknown_id"]);
    const result = addParentChain(relevant, allLabels);
    expect(result).toEqual(new Set(["unknown_id"]));
  });
});

describe("isCacheCovering", () => {
  beforeEach(() => {
    resetMsgCache();
    store.clear();
  });

  it("returns true for no-label when cache is complete", () => {
    const cache = getMsgCache();
    cache.complete = true;
    expect(isCacheCovering(null, null)).toBe(true);
  });

  it("returns false for label when cache is complete but no labelOldest", () => {
    const cache = getMsgCache();
    cache.complete = true;
    // Gmail API q="" misses user-label-only messages, so complete is not trusted for labels
    expect(isCacheCovering("Label_1", 1700000000000)).toBe(false);
  });

  it("returns false for no-label with scope=any when not complete", () => {
    expect(isCacheCovering(null, null)).toBe(false);
  });

  it("returns true for no-label when scope >= oldest", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering(null, 1700000000000)).toBe(true);
    expect(isCacheCovering(null, 1700100000000)).toBe(true);
  });

  it("returns false for no-label when scope < oldest", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering(null, 1699900000000)).toBe(false);
  });

  it("returns true for label when labelOldest covers scope", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering("Label_1", 1700000000000)).toBe(true);
    expect(isCacheCovering("Label_1", 1700100000000)).toBe(true);
  });

  it("returns false for label when labelOldest does not cover scope", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering("Label_1", 1699900000000)).toBe(false);
  });

  it("returns false for unknown label even when scope is within broad build range", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    // Gmail API q="" misses user-label-only messages, so broad build range is not trusted for labels
    expect(isCacheCovering("Label_Unknown", 1700000000000)).toBe(false);
  });

  it("returns false for unknown label when scope extends beyond broad build range", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering("Label_Unknown", 1699000000000)).toBe(false);
  });

  it("returns false for label with scope=any when not complete and no sentinel", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    expect(isCacheCovering("Label_1", null)).toBe(false);
  });

  it("returns true for label with scope=any when labelOldest sentinel is 0", () => {
    seedCache([
      { id: "m1", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);
    // Simulate completed targeted fetch for "any time" scope — sentinel value 0
    const cache = getMsgCache();
    cache.labelOldest["Label_1"] = 0;
    expect(isCacheCovering("Label_1", null)).toBe(true);
  });

  it("returns false for label after clearLabelOldest even within broad build range", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_1"], internalDate: 1700200000000 },
    ]);
    // Label_1 has labelOldest coverage
    expect(isCacheCovering("Label_1", 1700000000000)).toBe(true);
    // Simulate location change — clears per-label coverage
    clearLabelOldest();
    // No longer covered — targeted fetch needed (Gmail API q="" misses user-label-only messages)
    expect(isCacheCovering("Label_1", 1700000000000)).toBe(false);
    expect(isCacheCovering("Label_1", 1700100000000)).toBe(false);
  });
});
