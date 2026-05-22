import type { CacheMessage } from "@core/types.js";

const DB_NAME = "gmail-cache";
const DB_VERSION = 2;
const MESSAGES_STORE = "messages";
const META_STORE = "meta";
export const SUMMARY_DEALS_STORE = "summary-deals";
export const SUMMARY_REMINDERS_STORE = "summary-reminders";

const ALL_STORES = [MESSAGES_STORE, META_STORE, SUMMARY_DEALS_STORE, SUMMARY_REMINDERS_STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(indexedDB: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(SUMMARY_DEALS_STORE)) {
        db.createObjectStore(SUMMARY_DEALS_STORE, { keyPath: "messageId" });
      }
      if (!db.objectStoreNames.contains(SUMMARY_REMINDERS_STORE)) {
        db.createObjectStore(SUMMARY_REMINDERS_STORE, { keyPath: "messageId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Close the database and reset the cached promise (for testing or cache reset) */
export async function closeDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}

function withTransaction<T>(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putMessages(messages: CacheMessage[]): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readwrite");
    const store = tx.objectStore(MESSAGES_STORE);
    for (const msg of messages) {
      store.put(msg);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMessage(id: string): Promise<CacheMessage | undefined> {
  const db = await openDatabase();
  return withTransaction(db, MESSAGES_STORE, "readonly", (store) => store.get(id));
}

/** Batch-read multiple messages by ID in a single transaction. */
export async function getMessagesBatch(ids: string[]): Promise<Map<string, CacheMessage>> {
  if (ids.length === 0) return new Map();
  const db = await openDatabase();
  return new Promise<Map<string, CacheMessage>>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readonly");
    const store = tx.objectStore(MESSAGES_STORE);
    const results = new Map<string, CacheMessage>();
    let completed = 0;
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) results.set(id, request.result as CacheMessage);
        completed++;
        if (completed === ids.length) resolve(results);
      };
      request.onerror = () => reject(request.error);
    }
  });
}


export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const record = await withTransaction(db, META_STORE, "readonly", (store) => store.get(key));
  return record ? (record as { key: string; value: T }).value : undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await withTransaction(db, META_STORE, "readwrite", (store) => store.put({ key, value }));
}

export async function clearAll(): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ALL_STORES, "readwrite");
    for (const name of ALL_STORES) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSummaryRecords<T extends { messageId: string }>(storeName: string, ids: string[]): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  const db = await openDatabase();
  return new Promise<Map<string, T>>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const results = new Map<string, T>();
    let completed = 0;
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result) results.set(id, request.result as T);
        completed++;
        if (completed === ids.length) resolve(results);
      };
      request.onerror = () => reject(request.error);
    }
  });
}

export async function putSummaryRecords<T extends { messageId: string }>(storeName: string, records: T[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSummaryRecords(storeName: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeFromLabelIndex(labelId: string, idsToRemove: string[]): Promise<void> {
  if (idsToRemove.length === 0) return;
  const existing = await getMeta<string[]>(`labelIdx:${labelId}`);
  if (!existing) return;
  const removeSet = new Set(idsToRemove);
  const filtered = existing.filter((id) => !removeSet.has(id));
  if (filtered.length !== existing.length) await setMeta(`labelIdx:${labelId}`, filtered);
}

export async function addToLabelIndex(labelId: string, idsToAdd: string[]): Promise<void> {
  if (idsToAdd.length === 0) return;
  const existing = await getMeta<string[]>(`labelIdx:${labelId}`);
  const merged = existing ? [...existing] : [];
  const existingSet = new Set(merged);
  for (const id of idsToAdd) if (!existingSet.has(id)) merged.push(id);
  await setMeta(`labelIdx:${labelId}`, merged);
}

export async function getMessageCount(): Promise<number> {
  const db = await openDatabase();
  return withTransaction(db, MESSAGES_STORE, "readonly", (store) => store.count());
}

