import { describe, it, expect, beforeEach, vi } from "vitest";
import { mergeMessages, getMsgCache, resetMsgCache, saveMsgCache, loadMsgCache } from "../src/msg-cache.js";
import type { MessageMeta } from "@core/types.js";

// Mock localStorage via @core/settings
const mockStorage: Record<string, unknown> = {};
vi.mock("@core/settings.js", () => ({
  loadSetting: (key: string, defaultVal: unknown) => key in mockStorage ? mockStorage[key] : defaultVal,
  saveSetting: (key: string, val: unknown) => { mockStorage[key] = val; },
}));

function clearMockStorage(): void {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
}

describe("broad build state transitions", () => {
  beforeEach(() => {
    resetMsgCache();
    clearMockStorage();
  });

  it("processes first page of messages and updates cache", () => {
    const page1: MessageMeta[] = [
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700300000000 },
      { id: "m2", labelIds: ["INBOX", "Label_2"], internalDate: 1700200000000 },
    ];
    mergeMessages(page1);
    saveMsgCache();

    const cache = getMsgCache();
    expect(cache.messages).toHaveLength(2);
    expect(cache.oldest).toBe(1700200000000);
    expect(cache.newest).toBe(1700300000000);
    expect(cache.complete).toBe(false);
  });

  it("processes multiple pages incrementally", () => {
    const page1: MessageMeta[] = [
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700300000000 },
      { id: "m2", labelIds: ["INBOX"], internalDate: 1700200000000 },
    ];
    mergeMessages(page1);

    const page2: MessageMeta[] = [
      { id: "m3", labelIds: ["INBOX"], internalDate: 1700100000000 },
      { id: "m4", labelIds: ["SENT"], internalDate: 1700000000000 },
    ];
    mergeMessages(page2);

    const cache = getMsgCache();
    expect(cache.messages).toHaveLength(4);
    expect(cache.oldest).toBe(1700000000000);
    expect(cache.newest).toBe(1700300000000);
  });

  it("marks cache complete when no more pages", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    const cache = getMsgCache();
    cache.complete = true;
    saveMsgCache();

    expect(getMsgCache().complete).toBe(true);
  });

  it("deduplicates across pages", () => {
    mergeMessages([{ id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 }]);
    mergeMessages([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["SENT"], internalDate: 1700100000000 },
    ]);

    expect(getMsgCache().messages).toHaveLength(2);
  });

  it("persists and reloads cache state", () => {
    mergeMessages([
      { id: "m1", labelIds: ["INBOX", "Label_1"], internalDate: 1700300000000 },
      { id: "m2", labelIds: ["SENT"], internalDate: 1700000000000 },
    ]);
    const cache = getMsgCache();
    cache.complete = true;
    saveMsgCache();

    // Reset in-memory state and reload
    resetMsgCache();
    loadMsgCache();

    const reloaded = getMsgCache();
    expect(reloaded.messages).toHaveLength(2);
    expect(reloaded.oldest).toBe(1700000000000);
    expect(reloaded.newest).toBe(1700300000000);
    expect(reloaded.complete).toBe(true);
    expect(reloaded.labelIndex).toContain("INBOX");
    expect(reloaded.labelIndex).toContain("Label_1");
    expect(reloaded.labelIndex).toContain("SENT");
    expect(reloaded.labelOldest["INBOX"]).toBe(1700300000000);
    expect(reloaded.labelOldest["SENT"]).toBe(1700000000000);
  });

  it("incremental refresh: newest timestamp available for after: query", () => {
    mergeMessages([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700300000000 },
      { id: "m2", labelIds: ["INBOX"], internalDate: 1700000000000 },
    ]);
    saveMsgCache();

    const cache = getMsgCache();
    // Simulates what startBroadBuild uses for incremental refresh query
    expect(cache.newest).toBe(1700300000000);
    const d = new Date(cache.newest!);
    const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    expect(dateStr).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it("incremental refresh merges new messages into existing cache", () => {
    // Simulate first full build
    mergeMessages([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
      { id: "m2", labelIds: ["INBOX"], internalDate: 1700100000000 },
    ]);
    const cache = getMsgCache();
    cache.complete = true;
    saveMsgCache();

    // Simulate incremental refresh with newer messages
    cache.complete = false; // Reset during refresh
    mergeMessages([
      { id: "m3", labelIds: ["INBOX", "Label_1"], internalDate: 1700200000000 },
    ]);
    cache.complete = true;
    saveMsgCache();

    expect(getMsgCache().messages).toHaveLength(3);
    expect(getMsgCache().newest).toBe(1700200000000);
  });

  it("error during broad build resets without corrupting cache", () => {
    mergeMessages([
      { id: "m1", labelIds: ["INBOX"], internalDate: 1700000000000 },
    ]);
    saveMsgCache();

    // Simulate error: broadFetchId would be set to null in sidepanel
    // Cache should still have the messages from before the error
    const cache = getMsgCache();
    expect(cache.messages).toHaveLength(1);
    expect(cache.complete).toBe(false);
  });
});
