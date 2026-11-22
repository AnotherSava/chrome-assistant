import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDatabase, closeDatabase, getMeta, setMeta, clearAll, getSummaryRecords, putSummaryRecords, SUMMARY_DEALS_STORE } from "../src/cache-db.js";

beforeEach(async () => {
  // Close any open connection, then reopen fresh and clear all data
  await closeDatabase();
  await clearAll();
});

describe("openDatabase", () => {
  it("creates the meta and summary object stores", async () => {
    const db = await openDatabase();
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["meta", "summary-deals", "summary-reminders"]);
  });

  it("drops the retired messages store when upgrading a version 2 database", async () => {
    await closeDatabase();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase("gmail-cache"); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("gmail-cache", 2);
      request.onupgradeneeded = () => { request.result.createObjectStore("messages", { keyPath: "id" }); request.result.createObjectStore("meta", { keyPath: "key" }); };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = await openDatabase();
    expect(db.objectStoreNames.contains("messages")).toBe(false);
    expect(db.objectStoreNames.contains("summary-deals")).toBe(true);
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

describe("clearAll", () => {
  it("removes meta and summary records", async () => {
    await putSummaryRecords(SUMMARY_DEALS_STORE, [{ messageId: "msg1" }]);
    await setMeta("account", "/mail/u/0/");
    await clearAll();
    const records = await getSummaryRecords(SUMMARY_DEALS_STORE, ["msg1"]);
    expect(records.size).toBe(0);
    const val = await getMeta("account");
    expect(val).toBeUndefined();
  });
});
