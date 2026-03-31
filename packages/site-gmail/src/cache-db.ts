import type { CacheMessage } from "@core/types.js";

const DB_NAME = "gmail-cache";
const DB_VERSION = 1;
const MESSAGES_STORE = "messages";
const META_STORE = "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDatabase(indexedDB: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const store = db.createObjectStore(MESSAGES_STORE, { keyPath: "id" });
        store.createIndex("internalDate", "internalDate", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

export async function getMessagesByLabel(labelId: string): Promise<CacheMessage[]> {
  const db = await openDatabase();
  return new Promise<CacheMessage[]>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readonly");
    const store = tx.objectStore(MESSAGES_STORE);
    const request = store.openCursor();
    const results: CacheMessage[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const msg = cursor.value as CacheMessage;
        if (msg.labelIds.includes(labelId)) results.push(msg);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
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

export async function getMessagesWithoutDates(batchSize: number = 100): Promise<CacheMessage[]> {
  const db = await openDatabase();
  return new Promise<CacheMessage[]>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE, "readonly");
    const store = tx.objectStore(MESSAGES_STORE);
    const request = store.openCursor();
    const results: CacheMessage[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < batchSize) {
        const msg = cursor.value as CacheMessage;
        if (msg.internalDate === null) results.push(msg);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([MESSAGES_STORE, META_STORE], "readwrite");
    tx.objectStore(MESSAGES_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMessageCount(): Promise<number> {
  const db = await openDatabase();
  return withTransaction(db, MESSAGES_STORE, "readonly", (store) => store.count());
}
