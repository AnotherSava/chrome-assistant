import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cache-db module — getMeta returns null (no prior fetch state) by default
vi.mock("../src/cache-db.js", () => ({
  getMeta: vi.fn().mockResolvedValue(undefined),
}));

// Mock cache-manager module before background.ts imports it
vi.mock("../src/cache-manager.js", () => {
  const mockStartFetch = vi.fn().mockResolvedValue(undefined);
  const mockQueryLabel = vi.fn().mockResolvedValue({ labelId: "INBOX", count: 5, coLabelCounts: { STARRED: 1 } });
  const mockAbort = vi.fn();
  const mockSetProgressCallback = vi.fn();
  const mockUpdateSystemLabelSettings = vi.fn();
  const mockPrioritizeLabel = vi.fn().mockResolvedValue(undefined);
  return {
    CacheManager: vi.fn().mockImplementation(() => ({
      startFetch: mockStartFetch,
      queryLabel: mockQueryLabel,
      abort: mockAbort,
      setProgressCallback: mockSetProgressCallback,
      updateSystemLabelSettings: mockUpdateSystemLabelSettings,
      prioritizeLabel: mockPrioritizeLabel,
      resetReady: vi.fn(),
      resolveReady: vi.fn(),
      loadLabels: vi.fn().mockResolvedValue(undefined),
      markProcessed: vi.fn(),
      showStarred: false,
      showImportant: false,
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

const { getMeta } = await import("../src/cache-db.js") as unknown as { getMeta: ReturnType<typeof vi.fn> };
const { buildGmailUrl, startCacheIfNeeded, _resetCacheState, cacheManager } = await import("../src/background.js");

describe("buildGmailUrl", () => {
  const base = "https://mail.google.com/mail/u/0/";

  it("returns all-mail hash when no label and no scope", () => {
    expect(buildGmailUrl(base, null, null)).toBe(`${base}#all`);
  });

  it("returns inbox hash for INBOX system label with no scope", () => {
    expect(buildGmailUrl(base, "INBOX", null)).toBe(`${base}#inbox`);
  });

  it("returns sent hash for SENT system label with no scope", () => {
    expect(buildGmailUrl(base, "SENT", null)).toBe(`${base}#sent`);
  });

  it("returns starred hash for STARRED system label with no scope", () => {
    expect(buildGmailUrl(base, "STARRED", null)).toBe(`${base}#starred`);
  });

  it("returns imp hash for IMPORTANT system label with no scope", () => {
    expect(buildGmailUrl(base, "IMPORTANT", null)).toBe(`${base}#imp`);
  });

  it("returns search URL for system label with scope", () => {
    expect(buildGmailUrl(base, "INBOX", "2024/01/01")).toBe(`${base}#search/${encodeURIComponent("in:inbox after:2024/01/01")}`);
  });

  it("returns search URL with user label filter", () => {
    expect(buildGmailUrl(base, "Work", null)).toBe(`${base}#search/${encodeURIComponent('label:"work"')}`);
  });

  it("returns search URL with scope filter only", () => {
    expect(buildGmailUrl(base, null, "2024/01/01")).toBe(`${base}#search/${encodeURIComponent("after:2024/01/01")}`);
  });

  it("returns search URL with label and scope", () => {
    expect(buildGmailUrl(base, "Reports", "2024/01/01")).toBe(`${base}#search/${encodeURIComponent('label:"reports" after:2024/01/01')}`);
  });

  it("escapes label names with slashes and spaces", () => {
    expect(buildGmailUrl(base, "Work/Projects", null)).toBe(`${base}#search/${encodeURIComponent('label:"work-projects"')}`);
  });

  it("escapes quotes in label names", () => {
    expect(buildGmailUrl(base, 'My "Label"', null)).toBe(`${base}#search/${encodeURIComponent('label:"my-label"')}`);
  });
});

describe("startCacheIfNeeded", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
  });

  it("starts cache fetch on first call", async () => {
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
    expect(alarmsCreateMock).toHaveBeenCalledWith("cache-keepalive", { periodInMinutes: 0.4 });
  });

  it("does not restart cache for same account", async () => {
    await startCacheIfNeeded("/mail/u/0/");
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledTimes(1);
  });

  it("restarts cache on account change", async () => {
    await startCacheIfNeeded("/mail/u/0/");
    await startCacheIfNeeded("/mail/u/1/");
    expect(cacheManager.startFetch).toHaveBeenCalledTimes(2);
    expect(cacheManager.startFetch).toHaveBeenLastCalledWith("/mail/u/1/");
  });

  it("does not skip fetch when switching accounts even if old cache is fresh", async () => {
    // First call for account 0 — simulate fresh cache in IndexedDB for account 0
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      return Promise.resolve(undefined);
    });
    await startCacheIfNeeded("/mail/u/0/");
    // Fresh cache for same account — should skip (no startFetch) but still load labels
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    expect(cacheManager.loadLabels).toHaveBeenCalled();

    // Switch to account 1 — stored account is still "/mail/u/0/", so must NOT skip
    await startCacheIfNeeded("/mail/u/1/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/1/");
  });

  it("resets cacheStarted when loadLabels fails on skip path", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      return Promise.resolve(undefined);
    });
    (cacheManager.loadLabels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("auth failure"));
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.resolveReady).toHaveBeenCalled();
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    // cacheStarted should be reset so a subsequent call retries
    vi.clearAllMocks();
    getMeta.mockResolvedValue(undefined);
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
  });

  it("fetches missing system label indexes on skip path when settings are enabled", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      // STARRED index does not exist — should trigger prioritizeLabel
      if (key === "labelIdx:STARRED") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    (cacheManager as unknown as Record<string, unknown>).showStarred = true;
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    expect(cacheManager.prioritizeLabel).toHaveBeenCalledWith("STARRED");
    (cacheManager as unknown as Record<string, unknown>).showStarred = false;
  });

  it("does not fetch system label indexes on skip path when indexes already exist", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      if (key === "labelIdx:STARRED") return Promise.resolve(["msg2"]);
      return Promise.resolve(undefined);
    });
    (cacheManager as unknown as Record<string, unknown>).showStarred = true;
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    expect(cacheManager.prioritizeLabel).not.toHaveBeenCalled();
    // Existing index should be marked as processed to prevent duplicate fetch from syncSettings
    expect(cacheManager.markProcessed).toHaveBeenCalledWith("STARRED");
    (cacheManager as unknown as Record<string, unknown>).showStarred = false;
  });

  it("resets cacheStarted when skip-path backfill fails so next call retries", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      // STARRED index missing — triggers backfill
      if (key === "labelIdx:STARRED") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    (cacheManager as unknown as Record<string, unknown>).showStarred = true;
    (cacheManager.prioritizeLabel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network error"));
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.prioritizeLabel).toHaveBeenCalledWith("STARRED");
    // cacheStarted should be reset so the next call retries
    vi.clearAllMocks();
    getMeta.mockResolvedValue(undefined);
    (cacheManager as unknown as Record<string, unknown>).showStarred = false;
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
  });

  it("marks processed before resolving readiness gate so syncSettings skips duplicate fetch", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      if (key === "labelIdx:STARRED") return Promise.resolve(["msg2"]);
      return Promise.resolve(undefined);
    });
    (cacheManager as unknown as Record<string, unknown>).showStarred = true;
    const callOrder: string[] = [];
    (cacheManager.markProcessed as ReturnType<typeof vi.fn>).mockImplementation(() => { callOrder.push("markProcessed"); });
    (cacheManager.resolveReady as ReturnType<typeof vi.fn>).mockImplementation(() => { callOrder.push("resolveReady"); });
    await startCacheIfNeeded("/mail/u/0/");
    expect(callOrder.indexOf("markProcessed")).toBeLessThan(callOrder.indexOf("resolveReady"));
    (cacheManager as unknown as Record<string, unknown>).showStarred = false;
  });

  it("resets cacheStarted when skip-path label index check fails", async () => {
    getMeta.mockImplementation((key: string) => {
      if (key === "account") return Promise.resolve("/mail/u/0/");
      if (key === "fetchState") return Promise.resolve({ phase: "complete", lastFetchTimestamp: Date.now() });
      if (key === "labelIdx:INBOX") return Promise.resolve(["msg1"]);
      if (key === "labelIdx:STARRED") return Promise.reject(new Error("IndexedDB read error"));
      return Promise.resolve(undefined);
    });
    (cacheManager as unknown as Record<string, unknown>).showStarred = true;
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.resolveReady).toHaveBeenCalled();
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    // cacheStarted should be reset so a subsequent call retries
    vi.clearAllMocks();
    getMeta.mockResolvedValue(undefined);
    (cacheManager as unknown as Record<string, unknown>).showStarred = false;
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
  });

  it("resolves readiness gate and resets cacheStarted when preflight getMeta throws", async () => {
    getMeta.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.resolveReady).toHaveBeenCalled();
    expect(cacheManager.startFetch).not.toHaveBeenCalled();
    // cacheStarted should be reset so a subsequent call retries
    vi.clearAllMocks();
    getMeta.mockResolvedValue(undefined);
    await startCacheIfNeeded("/mail/u/0/");
    expect(cacheManager.startFetch).toHaveBeenCalledWith("/mail/u/0/");
  });
});

