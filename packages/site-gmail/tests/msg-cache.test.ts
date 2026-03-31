import { describe, it, expect, beforeEach, vi } from "vitest";
import { mergeMessages, getMsgCache, resetMsgCache, scopeToTimestamp } from "../src/msg-cache.js";
import type { MessageMeta } from "@core/types.js";

// Mock localStorage via @core/settings
vi.mock("@core/settings.js", () => ({
  loadSetting: (_key: string, defaultVal: unknown) => defaultVal,
  saveSetting: () => {},
}));

describe("mergeMessages", () => {
  beforeEach(() => {
    resetMsgCache();
  });

  it("adds messages to an empty cache", () => {
    const messages: MessageMeta[] = [
      { id: "msg1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "msg2", labelIds: ["SENT", "Label_2"], internalDate: 1700100000000 },
    ];
    mergeMessages(messages);
    const cache = getMsgCache();

    expect(cache.messages).toHaveLength(2);
    expect(cache.labelIndex).toContain("INBOX");
    expect(cache.labelIndex).toContain("Label_1");
    expect(cache.labelIndex).toContain("SENT");
    expect(cache.labelIndex).toContain("Label_2");
  });

  it("stores messages in compact format [internalDate, ...labelIndices]", () => {
    mergeMessages([{ id: "msg1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 }]);
    const cache = getMsgCache();

    const entry = cache.messages[0];
    expect(entry[0]).toBe(1700000000000);
    // Remaining entries are label indices
    const inboxIdx = cache.labelIndex.indexOf("INBOX");
    const label1Idx = cache.labelIndex.indexOf("Label_1");
    expect(entry.slice(1).sort()).toEqual([inboxIdx, label1Idx].sort());
  });

  it("deduplicates by message ID", () => {
    const msg: MessageMeta = { id: "msg1", labelIds: ["INBOX"], internalDate: 1700000000000 };
    mergeMessages([msg]);
    mergeMessages([msg]);
    mergeMessages([msg]);

    expect(getMsgCache().messages).toHaveLength(1);
  });

  it("reuses label indices for repeated labels", () => {
    mergeMessages([
      { id: "msg1", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 },
      { id: "msg2", labelIds: ["INBOX", "Label_2"], internalDate: 1700100000000 },
    ]);
    const cache = getMsgCache();

    // INBOX should appear only once in the index
    const inboxCount = cache.labelIndex.filter((l) => l === "INBOX").length;
    expect(inboxCount).toBe(1);

    // Both messages should reference the same INBOX index
    const inboxIdx = cache.labelIndex.indexOf("INBOX");
    expect(cache.messages[0]).toContain(inboxIdx);
    expect(cache.messages[1]).toContain(inboxIdx);
  });

  it("tracks oldest message timestamp", () => {
    mergeMessages([
      { id: "msg1", labelIds: ["INBOX"], internalDate: 1700200000000 },
      { id: "msg2", labelIds: ["INBOX"], internalDate: 1700000000000 },
      { id: "msg3", labelIds: ["INBOX"], internalDate: 1700100000000 },
    ]);

    expect(getMsgCache().oldest).toBe(1700000000000);
  });

  it("updates oldest when merging older messages", () => {
    mergeMessages([{ id: "msg1", labelIds: ["INBOX"], internalDate: 1700200000000 }]);
    expect(getMsgCache().oldest).toBe(1700200000000);

    mergeMessages([{ id: "msg2", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    expect(getMsgCache().oldest).toBe(1700000000000);
  });

  it("tracks per-label oldest timestamps", () => {
    mergeMessages([
      { id: "msg1", labelIds: ["INBOX", "Label_1"], internalDate: 1700200000000 },
      { id: "msg2", labelIds: ["INBOX", "Label_2"], internalDate: 1700100000000 },
      { id: "msg3", labelIds: ["Label_1"], internalDate: 1700000000000 },
    ]);

    const cache = getMsgCache();
    expect(cache.labelOldest["INBOX"]).toBe(1700100000000);
    expect(cache.labelOldest["Label_1"]).toBe(1700000000000);
    expect(cache.labelOldest["Label_2"]).toBe(1700100000000);
  });

  it("handles messages with no labels", () => {
    mergeMessages([{ id: "msg1", labelIds: [], internalDate: 1700000000000 }]);
    const cache = getMsgCache();

    expect(cache.messages).toHaveLength(1);
    expect(cache.messages[0]).toEqual([1700000000000]);
  });

  it("tracks newest message timestamp", () => {
    mergeMessages([
      { id: "msg1", labelIds: ["INBOX"], internalDate: 1700000000000 },
      { id: "msg2", labelIds: ["INBOX"], internalDate: 1700200000000 },
      { id: "msg3", labelIds: ["INBOX"], internalDate: 1700100000000 },
    ]);

    expect(getMsgCache().newest).toBe(1700200000000);
  });

  it("updates newest when merging newer messages", () => {
    mergeMessages([{ id: "msg1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    expect(getMsgCache().newest).toBe(1700000000000);

    mergeMessages([{ id: "msg2", labelIds: ["INBOX"], internalDate: 1700200000000 }]);
    expect(getMsgCache().newest).toBe(1700200000000);
  });

  it("does not update newest when merging older messages", () => {
    mergeMessages([{ id: "msg1", labelIds: ["INBOX"], internalDate: 1700200000000 }]);
    expect(getMsgCache().newest).toBe(1700200000000);

    mergeMessages([{ id: "msg2", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    expect(getMsgCache().newest).toBe(1700200000000);
  });

  it("handles multiple merges incrementally", () => {
    mergeMessages([{ id: "msg1", labelIds: ["INBOX"], internalDate: 1700200000000 }]);
    mergeMessages([{ id: "msg2", labelIds: ["SENT"], internalDate: 1700100000000 }]);
    mergeMessages([{ id: "msg3", labelIds: ["INBOX", "Label_1"], internalDate: 1700000000000 }]);

    const cache = getMsgCache();
    expect(cache.messages).toHaveLength(3);
    expect(cache.oldest).toBe(1700000000000);
    expect(cache.labelIndex).toContain("INBOX");
    expect(cache.labelIndex).toContain("SENT");
    expect(cache.labelIndex).toContain("Label_1");
  });
});

describe("scopeToTimestamp", () => {
  it("returns null for 'any'", () => {
    expect(scopeToTimestamp("any")).toBeNull();
  });

  it("returns null for unknown scope", () => {
    expect(scopeToTimestamp("unknown")).toBeNull();
  });

  it("returns a timestamp in the past for '1w'", () => {
    const result = scopeToTimestamp("1w");
    expect(result).not.toBeNull();
    const diff = Date.now() - result!;
    // Should be approximately 7 days (within a second tolerance)
    expect(Math.abs(diff - 7 * 86400000)).toBeLessThan(1000);
  });

  it("returns a timestamp in the past for '1y'", () => {
    const result = scopeToTimestamp("1y");
    expect(result).not.toBeNull();
    // Should be roughly 365 days ago (within a day tolerance for leap years)
    const diffDays = (Date.now() - result!) / 86400000;
    expect(diffDays).toBeGreaterThan(364);
    expect(diffDays).toBeLessThan(367);
  });

  it("returns progressively older timestamps for wider scopes", () => {
    const w1 = scopeToTimestamp("1w")!;
    const m1 = scopeToTimestamp("1m")!;
    const y1 = scopeToTimestamp("1y")!;
    const y5 = scopeToTimestamp("5y")!;

    expect(w1).toBeGreaterThan(m1);
    expect(m1).toBeGreaterThan(y1);
    expect(y1).toBeGreaterThan(y5);
  });
});
