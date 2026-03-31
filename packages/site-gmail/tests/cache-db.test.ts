import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDatabase, closeDatabase, putMessages, getMessage, getMessagesByLabel, getMeta, setMeta, getMessagesWithoutDates, clearAll, getMessageCount } from "../src/cache-db.js";
import type { CacheMessage } from "@core/types.js";

beforeEach(async () => {
  // Close any open connection, then reopen fresh and clear all data
  await closeDatabase();
  await clearAll();
});

describe("openDatabase", () => {
  it("creates messages and meta object stores", async () => {
    const db = await openDatabase();
    expect(db.objectStoreNames.contains("messages")).toBe(true);
    expect(db.objectStoreNames.contains("meta")).toBe(true);
  });

  it("creates internalDate index on messages store", async () => {
    const db = await openDatabase();
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    expect(store.indexNames.contains("internalDate")).toBe(true);
  });

  it("returns the same promise on subsequent calls", async () => {
    const p1 = openDatabase();
    const p2 = openDatabase();
    expect(p1).toBe(p2);
    const db1 = await p1;
    const db2 = await p2;
    expect(db1).toBe(db2);
  });
});

describe("putMessages", () => {
  it("inserts messages into the store", async () => {
    const msgs: CacheMessage[] = [
      { id: "msg1", internalDate: 1700000000000, labelIds: ["INBOX", "Label_1"] },
      { id: "msg2", internalDate: null, labelIds: ["SENT"] },
    ];
    await putMessages(msgs);
    const count = await getMessageCount();
    expect(count).toBe(2);
  });

  it("upserts messages with the same id", async () => {
    await putMessages([{ id: "msg1", internalDate: null, labelIds: ["INBOX"] }]);
    await putMessages([{ id: "msg1", internalDate: 1700000000000, labelIds: ["INBOX", "SENT"] }]);
    const count = await getMessageCount();
    expect(count).toBe(1);
    const msg = await getMessage("msg1");
    expect(msg?.internalDate).toBe(1700000000000);
    expect(msg?.labelIds).toEqual(["INBOX", "SENT"]);
  });
});

describe("getMessage", () => {
  it("returns undefined for missing id", async () => {
    const msg = await getMessage("nonexistent");
    expect(msg).toBeUndefined();
  });

  it("returns the stored message", async () => {
    await putMessages([{ id: "msg1", internalDate: 123, labelIds: ["A"] }]);
    const msg = await getMessage("msg1");
    expect(msg).toEqual({ id: "msg1", internalDate: 123, labelIds: ["A"] });
  });
});

describe("getMessagesByLabel", () => {
  it("returns only messages with the specified label", async () => {
    await putMessages([
      { id: "msg1", internalDate: 100, labelIds: ["INBOX", "Label_1"] },
      { id: "msg2", internalDate: 200, labelIds: ["SENT"] },
      { id: "msg3", internalDate: 300, labelIds: ["INBOX", "Label_2"] },
    ]);
    const results = await getMessagesByLabel("INBOX");
    expect(results).toHaveLength(2);
    expect(results.map((m) => m.id).sort()).toEqual(["msg1", "msg3"]);
  });

  it("returns empty array when no messages have the label", async () => {
    await putMessages([{ id: "msg1", internalDate: 100, labelIds: ["INBOX"] }]);
    const results = await getMessagesByLabel("NONEXISTENT");
    expect(results).toHaveLength(0);
  });
});

describe("getMeta / setMeta", () => {
  it("returns undefined for missing key", async () => {
    const val = await getMeta("missing");
    expect(val).toBeUndefined();
  });

  it("stores and retrieves a value", async () => {
    await setMeta("account", "/mail/u/0/");
    const val = await getMeta<string>("account");
    expect(val).toBe("/mail/u/0/");
  });

  it("stores complex objects", async () => {
    const state = { phase: "labels", progress: 0.5, labelsFetched: 10, datesFetched: 0 };
    await setMeta("fetchState", state);
    const val = await getMeta<typeof state>("fetchState");
    expect(val).toEqual(state);
  });

  it("overwrites existing values", async () => {
    await setMeta("account", "/mail/u/0/");
    await setMeta("account", "/mail/u/1/");
    const val = await getMeta<string>("account");
    expect(val).toBe("/mail/u/1/");
  });
});

describe("getMessagesWithoutDates", () => {
  it("returns only messages with internalDate === null", async () => {
    await putMessages([
      { id: "msg1", internalDate: 1700000000000, labelIds: ["INBOX"] },
      { id: "msg2", internalDate: null, labelIds: ["SENT"] },
      { id: "msg3", internalDate: null, labelIds: ["INBOX"] },
      { id: "msg4", internalDate: 1700100000000, labelIds: ["SENT"] },
    ]);
    const results = await getMessagesWithoutDates();
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.internalDate === null)).toBe(true);
  });

  it("respects batchSize limit", async () => {
    const msgs: CacheMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `msg${i}`,
      internalDate: null,
      labelIds: ["INBOX"],
    }));
    await putMessages(msgs);
    const results = await getMessagesWithoutDates(3);
    expect(results).toHaveLength(3);
  });

  it("returns empty array when all messages have dates", async () => {
    await putMessages([
      { id: "msg1", internalDate: 100, labelIds: ["INBOX"] },
      { id: "msg2", internalDate: 200, labelIds: ["SENT"] },
    ]);
    const results = await getMessagesWithoutDates();
    expect(results).toHaveLength(0);
  });
});

describe("clearAll", () => {
  it("removes all messages and meta", async () => {
    await putMessages([{ id: "msg1", internalDate: 100, labelIds: ["INBOX"] }]);
    await setMeta("account", "/mail/u/0/");
    await clearAll();
    const count = await getMessageCount();
    expect(count).toBe(0);
    const val = await getMeta("account");
    expect(val).toBeUndefined();
  });
});

describe("getMessageCount", () => {
  it("returns 0 for empty store", async () => {
    const count = await getMessageCount();
    expect(count).toBe(0);
  });

  it("returns correct count after inserts", async () => {
    await putMessages([
      { id: "msg1", internalDate: 100, labelIds: ["INBOX"] },
      { id: "msg2", internalDate: 200, labelIds: ["SENT"] },
      { id: "msg3", internalDate: null, labelIds: ["INBOX"] },
    ]);
    const count = await getMessageCount();
    expect(count).toBe(3);
  });
});
