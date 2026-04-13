import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadSettings, saveSetting, onSettingChanged } from "../src/settings.js";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const result: Record<string, string> = {};
          for (const key of keys) {
            const val = store.get(key);
            if (val !== undefined) result[key] = val;
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, string>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  });
});

describe("loadSettings", () => {
  it("returns defaults when no keys stored", async () => {
    const result = await loadSettings({ num: 42, str: "hello" });
    expect(result).toEqual({ num: 42, str: "hello" });
  });

  it("returns stored values merged with defaults", async () => {
    store.set("num", "7");
    const result = await loadSettings({ num: 0, str: "default" });
    expect(result.num).toBe(7);
    expect(result.str).toBe("default");
  });

  it("returns stored string value", async () => {
    store.set("str", '"hello"');
    const result = await loadSettings({ str: "default" });
    expect(result.str).toBe("hello");
  });

  it("keeps default on malformed JSON", async () => {
    store.set("bad", "{invalid");
    const result = await loadSettings({ bad: "fallback" });
    expect(result.bad).toBe("fallback");
  });

  it("returns a copy of defaults so caller cannot mutate the original", async () => {
    const defaults = { x: 10 };
    const result1 = await loadSettings(defaults);
    result1.x = 999;
    const result2 = await loadSettings(defaults);
    expect(result2.x).toBe(10);
  });
});

describe("saveSetting", () => {
  it("persists a primitive value", () => {
    saveSetting("key", 42);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ key: "42" });
  });

  it("persists an object value", () => {
    saveSetting("key", { a: 1 });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ key: '{"a":1}' });
  });
});

describe("onSettingChanged", () => {
  it("registers a chrome.storage.onChanged listener", () => {
    onSettingChanged(() => {});
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it("parses changed values and calls callback", () => {
    const callback = vi.fn();
    let listener: (changes: Record<string, { newValue?: string }>, area: string) => void = () => {};
    (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mockImplementation((fn: typeof listener) => { listener = fn; });
    onSettingChanged(callback);
    listener({ myKey: { newValue: '"hello"' } }, "local");
    expect(callback).toHaveBeenCalledWith({ myKey: "hello" });
  });

  it("ignores non-local storage changes", () => {
    const callback = vi.fn();
    let listener: (changes: Record<string, { newValue?: string }>, area: string) => void = () => {};
    (chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mockImplementation((fn: typeof listener) => { listener = fn; });
    onSettingChanged(callback);
    listener({ myKey: { newValue: '"hello"' } }, "sync");
    expect(callback).not.toHaveBeenCalled();
  });
});
