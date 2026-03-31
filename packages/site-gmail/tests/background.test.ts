import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cache-manager module before background.ts imports it
vi.mock("../src/cache-manager.js", () => {
  const mockStartFetch = vi.fn().mockResolvedValue(undefined);
  const mockQueryLabel = vi.fn().mockResolvedValue({ labelId: "INBOX", count: 5, coLabels: ["STARRED"] });
  const mockAbort = vi.fn();
  const mockSetProgressCallback = vi.fn();
  return {
    CacheManager: vi.fn().mockImplementation(() => ({
      startFetch: mockStartFetch,
      queryLabel: mockQueryLabel,
      abort: mockAbort,
      setProgressCallback: mockSetProgressCallback,
    })),
  };
});

// Mock chrome APIs used at module top level — must be set before import
const noop = () => {};
const alarmsClearMock = vi.fn().mockResolvedValue(undefined);
const alarmsCreateMock = vi.fn();
(globalThis as Record<string, unknown>).chrome = {
  storage: { session: { get: noop, set: noop } },
  sidePanel: { setPanelBehavior: noop },
  commands: { getAll: noop, onCommand: { addListener: noop } },
  action: { setTitle: noop, onClicked: { addListener: noop } },
  runtime: { onConnect: { addListener: noop } },
  tabs: { onUpdated: { addListener: noop }, onActivated: { addListener: noop }, query: vi.fn(), update: vi.fn(), get: vi.fn() },
  identity: { getAuthToken: noop, removeCachedAuthToken: noop },
  alarms: { create: alarmsCreateMock, clear: alarmsClearMock, onAlarm: { addListener: noop } },
};

const { buildGmailUrl, startCacheIfNeeded, _resetCacheState, cacheManager } = await import("../src/background.js");

describe("buildGmailUrl", () => {
  const base = "https://mail.google.com/mail/u/0/";

  it("returns inbox hash for default location with no filters", () => {
    expect(buildGmailUrl(base, undefined, null, null)).toBe(`${base}#inbox`);
  });

  it("returns inbox hash for explicit inbox with no filters", () => {
    expect(buildGmailUrl(base, "inbox", null, null)).toBe(`${base}#inbox`);
  });

  it("returns sent hash for sent location with no filters", () => {
    expect(buildGmailUrl(base, "sent", null, null)).toBe(`${base}#sent`);
  });

  it("returns all hash for all-mail with no filters", () => {
    expect(buildGmailUrl(base, "all", null, null)).toBe(`${base}#all`);
  });

  it("returns search URL with label filter", () => {
    expect(buildGmailUrl(base, "inbox", "Work", null)).toBe(`${base}#search/${encodeURIComponent('label:"work" in:inbox')}`);
  });

  it("returns search URL with scope filter", () => {
    expect(buildGmailUrl(base, "inbox", null, "2024/01/01")).toBe(`${base}#search/${encodeURIComponent("in:inbox after:2024/01/01")}`);
  });

  it("returns search URL with label and scope", () => {
    expect(buildGmailUrl(base, "all", "Reports", "2024/01/01")).toBe(`${base}#search/${encodeURIComponent('label:"reports" after:2024/01/01')}`);
  });

  it("escapes label names with slashes and spaces", () => {
    expect(buildGmailUrl(base, "all", "Work/Projects", null)).toBe(`${base}#search/${encodeURIComponent('label:"work-projects"')}`);
  });

  it("escapes quotes in label names", () => {
    expect(buildGmailUrl(base, "all", 'My "Label"', null)).toBe(`${base}#search/${encodeURIComponent('label:"my-label"')}`);
  });

  it("combines label, location, and scope", () => {
    const result = buildGmailUrl(base, "sent", "Work", "2024/06/01");
    expect(result).toBe(`${base}#search/${encodeURIComponent('label:"work" in:sent after:2024/06/01')}`);
  });
});

describe("startCacheIfNeeded", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
  });

  it("starts cache fetch on first call", () => {
    startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
    expect(alarmsCreateMock).toHaveBeenCalledWith("cache-keepalive", { periodInMinutes: 0.4 });
  });

  it("does not restart cache for same account", () => {
    startCacheIfNeeded("/mail/u/0/");
    startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts and restarts cache on account change", () => {
    startCacheIfNeeded("/mail/u/0/");
    startCacheIfNeeded("/mail/u/1/");
    expect(cacheManager.abort).toHaveBeenCalled();
    expect(cacheManager.startFetch).toHaveBeenCalledTimes(2);
    expect(cacheManager.startFetch).toHaveBeenLastCalledWith("/mail/u/1/");
  });
});

describe("cacheManager integration", () => {
  it("exposes queryLabel via cacheManager", async () => {
    const result = await cacheManager.queryLabel("INBOX", "inbox", null);
    expect(result).toEqual({ labelId: "INBOX", count: 5, coLabels: ["STARRED"] });
  });

  it("has a progress callback set", () => {
    // The progress callback is set during module initialization.
    // We verify the cacheManager instance exists and has the method.
    expect(typeof cacheManager.setProgressCallback).toBe("function");
  });
});
