import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSetting, saveSetting } from "../settings.js";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
});

describe("loadSetting", () => {
  it("returns default when key is missing", () => {
    expect(loadSetting("missing", 42)).toBe(42);
  });

  it("returns stored primitive value", () => {
    store.set("num", "7");
    expect(loadSetting("num", 0)).toBe(7);
  });

  it("returns stored string value", () => {
    store.set("str", '"hello"');
    expect(loadSetting("str", "default")).toBe("hello");
  });

  it("merges stored object with defaults", () => {
    store.set("obj", '{"a":1}');
    expect(loadSetting("obj", { a: 0, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("returns default on malformed JSON", () => {
    store.set("bad", "{invalid");
    expect(loadSetting("bad", "fallback")).toBe("fallback");
  });

  it("returns a copy of object defaults so caller cannot mutate the original", () => {
    const defaults = { x: 10 };
    const result1 = loadSetting("empty", defaults);
    result1.x = 999;
    const result2 = loadSetting("empty", defaults);
    expect(result2.x).toBe(10);
  });
});

describe("saveSetting", () => {
  it("persists a primitive value", () => {
    saveSetting("key", 42);
    expect(store.get("key")).toBe("42");
  });

  it("persists an object value", () => {
    saveSetting("key", { a: 1 });
    expect(store.get("key")).toBe('{"a":1}');
  });

  it("does not throw when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
    });
    expect(() => saveSetting("key", "value")).not.toThrow();
  });
});
