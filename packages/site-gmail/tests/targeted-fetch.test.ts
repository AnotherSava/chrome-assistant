import { describe, it, expect, beforeEach, vi } from "vitest";
import { mergeMessages, getMsgCache, resetMsgCache, saveMsgCache, filterMessages, deriveRelevantLabelIds, addParentChain, isCacheCovering } from "../src/msg-cache.js";
import type { MessageMeta } from "@core/types.js";

vi.mock("@core/settings.js", () => ({
  loadSetting: (key: string, defaultVal: unknown) => key in mockStorage ? mockStorage[key] : defaultVal,
  saveSetting: (key: string, val: unknown) => { mockStorage[key] = val; },
}));

const mockStorage: Record<string, unknown> = {};
function clearMockStorage(): void {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

function seedCache(messages: MessageMeta[]): void {
  mergeMessages(messages);
}

describe("targeted fetch state transitions", () => {
  beforeEach(() => {
    resetMsgCache();
    clearMockStorage();
  });

  it("partial broad build does not cover label beyond cached range", () => {
    // Broad build has messages from Nov 2023, but Label_X only appears in Oct 2023
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_B"], internalDate: 1700100000000 },
    ]);
    // Label_X is not in cache at all — should not be covering
    expect(isCacheCovering("Label_X", 1699000000000)).toBe(false);
    // Label_A is in cache but oldest is at 1700000000000, scope asks for older
    expect(isCacheCovering("Label_A", 1699000000000)).toBe(false);
  });

  it("targeted fetch merges gap messages into existing cache", () => {
    // Simulate broad build partial cache
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_B"], internalDate: 1700100000000 },
    ]);
    const cache = getMsgCache();
    expect(cache.messages).toHaveLength(2);
    expect(cache.oldest).toBe(1700000000000);

    // Simulate targeted fetch returning gap messages (older than broad build)
    const targetedPage: MessageMeta[] = [
      { id: "m3", labelIds: ["INBOX", "Label_A", "Label_C"], internalDate: 1699800000000 },
      { id: "m4", labelIds: ["INBOX", "Label_A"], internalDate: 1699700000000 },
    ];
    mergeMessages(targetedPage);

    expect(cache.messages).toHaveLength(4);
    expect(cache.oldest).toBe(1699700000000);
    // Label_A now has older coverage
    expect(cache.labelOldest["Label_A"]).toBe(1699700000000);
    // New label discovered
    expect(cache.labelOldest["Label_C"]).toBe(1699800000000);
  });

  it("after targeted fetch completes, cache covers label for scope", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
    ]);
    // Not covered at deeper scope
    expect(isCacheCovering("Label_A", 1699000000000)).toBe(false);

    // Targeted fetch fills the gap
    seedCache([
      { id: "m2", labelIds: ["INBOX", "Label_A"], internalDate: 1699000000000 },
    ]);

    // Simulate what sidepanel does: set labelOldest to scopeTimestamp
    const cache = getMsgCache();
    cache.labelOldest["Label_A"] = 1699000000000;
    saveMsgCache();

    // Now it's covered
    expect(isCacheCovering("Label_A", 1699000000000)).toBe(true);
  });

  it("deduplicates when targeted fetch overlaps with broad cache", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
    ]);

    // Targeted fetch includes a message already in broad cache
    const targetedPage: MessageMeta[] = [
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_A"], internalDate: 1699900000000 },
    ];
    mergeMessages(targetedPage);

    expect(getMsgCache().messages).toHaveLength(2); // Not 3
  });

  it("targeted fetch reveals co-occurring labels for filtering", () => {
    // Broad cache has Label_A and Label_B
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A", "Label_B"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX", "Label_C"], internalDate: 1700100000000 },
    ]);

    // Targeted fetch for Label_A brings in more messages with co-occurring labels
    const targetedPage: MessageMeta[] = [
      { id: "m3", labelIds: ["INBOX", "Label_A", "Label_D"], internalDate: 1699800000000 },
      { id: "m4", labelIds: ["INBOX", "Label_A", "Label_E"], internalDate: 1699700000000 },
    ];
    mergeMessages(targetedPage);

    // Filter for Label_A in inbox
    const filtered = filterMessages("inbox", null, "Label_A");
    expect(filtered).toHaveLength(3); // m1, m3, m4

    const relevant = deriveRelevantLabelIds(filtered);
    expect(relevant).toContain("Label_A");
    expect(relevant).toContain("Label_B"); // co-occurring from m1
    expect(relevant).toContain("Label_D"); // co-occurring from m3
    expect(relevant).toContain("Label_E"); // co-occurring from m4
    expect(relevant).not.toContain("Label_C"); // not co-occurring with Label_A
  });

  it("dimming logic: relevant labels include parent chain", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A_B_C"], internalDate: 1700000000000 },
    ]);

    const filtered = filterMessages("all", null, null);
    let relevant = deriveRelevantLabelIds(filtered);

    const allLabels = [
      { id: "Label_A", name: "A" },
      { id: "Label_A_B", name: "A/B" },
      { id: "Label_A_B_C", name: "A/B/C" },
      { id: "Label_D", name: "D" },
    ];

    relevant = addParentChain(relevant, allLabels);
    expect(relevant).toContain("Label_A");
    expect(relevant).toContain("Label_A_B");
    expect(relevant).toContain("Label_A_B_C");
    expect(relevant).not.toContain("Label_D");
  });

  it("error during targeted fetch does not corrupt cache", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
    ]);
    saveMsgCache();

    // Simulate targeted fetch that got one page before error
    mergeMessages([
      { id: "m2", labelIds: ["INBOX", "Label_A"], internalDate: 1699900000000 },
    ]);
    // Error happens here — sidepanel resets targeted state
    // Cache should still have both messages
    expect(getMsgCache().messages).toHaveLength(2);
    expect(getMsgCache().oldest).toBe(1699900000000);
  });

  it("subsequent targeted fetch for same label is instant when covered", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
    ]);
    const cache = getMsgCache();
    // Simulate targeted fetch completion setting labelOldest
    const scopeTs = 1699000000000;
    cache.labelOldest["Label_A"] = scopeTs;

    // Now same query should be covered
    expect(isCacheCovering("Label_A", scopeTs)).toBe(true);
    // Even slightly newer scope should be covered
    expect(isCacheCovering("Label_A", scopeTs + 1000)).toBe(true);
  });

  it("broadening scope beyond labelOldest triggers new targeted fetch", () => {
    seedCache([
      { id: "m1", labelIds: ["INBOX", "Label_A"], internalDate: 1700000000000 },
    ]);
    const cache = getMsgCache();
    cache.labelOldest["Label_A"] = 1699000000000;

    // Scope within coverage — covered
    expect(isCacheCovering("Label_A", 1699000000000)).toBe(true);
    // Scope beyond coverage — not covered, needs targeted fetch
    expect(isCacheCovering("Label_A", 1698000000000)).toBe(false);
  });
});
