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
  const mockGetLabels = vi.fn().mockReturnValue([]);
  const mockSetLabels = vi.fn();
  const mockGetLabelCounts = vi.fn().mockResolvedValue({ INBOX: { own: 10, inclusive: 10 } });
  let activeScopeTimestamp: number | null | undefined = undefined;
  const mockSetScopeFilter = vi.fn().mockImplementation((ts: number | null) => { activeScopeTimestamp = ts; return Promise.resolve(); });
  const mockGetActiveScopeTimestamp = vi.fn().mockImplementation(() => activeScopeTimestamp);
  const mockClearScopeState = vi.fn().mockImplementation(() => { activeScopeTimestamp = undefined; });
  return {
    CacheManager: vi.fn().mockImplementation(() => ({
      startFetch: mockStartFetch,
      queryLabel: mockQueryLabel,
      abort: mockAbort,
      setProgressCallback: mockSetProgressCallback,
      updateSystemLabelSettings: mockUpdateSystemLabelSettings,
      prioritizeLabel: mockPrioritizeLabel,
      getLabels: mockGetLabels,
      setLabels: mockSetLabels,
      getLabelCounts: mockGetLabelCounts,
      setScopeFilter: mockSetScopeFilter,
      getActiveScopeTimestamp: mockGetActiveScopeTimestamp,
      clearScopeState: mockClearScopeState,
      resetReady: vi.fn(),
      resolveReady: vi.fn(),
      loadLabels: vi.fn().mockResolvedValue(undefined),
      whenReady: vi.fn().mockResolvedValue(undefined),
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
let onConnectListener: ((port: unknown) => void) | null = null;
const tabsUpdateMock = vi.fn().mockResolvedValue(undefined);
(globalThis as Record<string, unknown>).chrome = {
  storage: { session: { get: noop, set: noop } },
  sidePanel: { setPanelBehavior: noop },
  commands: { getAll: noop, onCommand: { addListener: noop } },
  action: { setTitle: noop, onClicked: { addListener: noop } },
  runtime: { onConnect: { addListener: (cb: (port: unknown) => void) => { onConnectListener = cb; } } },
  tabs: { onUpdated: { addListener: noop }, onActivated: { addListener: noop }, query: vi.fn(), update: tabsUpdateMock, get: vi.fn() },
  identity: { getAuthToken: noop, removeCachedAuthToken: noop },
  alarms: { create: alarmsCreateMock, clear: alarmsClearMock, onAlarm: { addListener: noop } },
};

const { getMeta } = await import("../src/cache-db.js") as unknown as { getMeta: ReturnType<typeof vi.fn> };
const { buildGmailUrl, startCacheIfNeeded, _resetCacheState, cacheManager } = await import("../src/background.js");

// Capture the progress callback registered at module load time (before any clearAllMocks)
const progressCallback = (cacheManager.setProgressCallback as ReturnType<typeof vi.fn>).mock.calls[0][0] as (progress: Record<string, unknown>) => void;

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

  it("builds OR query for array of label names", () => {
    const url = buildGmailUrl(base, ["Work", "Work/Projects"], null);
    expect(url).toContain("search");
    const decoded = decodeURIComponent(url.split("#search/")[1]);
    expect(decoded).toContain("work");
    expect(decoded).toContain("work-projects");
    expect(decoded).toMatch(/OR/i);
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

/** Helper: create a fake port and connect it through the onConnect listener. */
function createConnectedPort(gmailTabId: number, gmailTabUrl: string): { port: { postMessage: ReturnType<typeof vi.fn>; name: string; onMessage: { addListener: (cb: (msg: Record<string, unknown>) => void) => void }; onDisconnect: { addListener: (cb: () => void) => void } }; sendMessage: (msg: Record<string, unknown>) => void } {
  let messageListener: ((msg: Record<string, unknown>) => void) | null = null;
  const port = {
    name: "sidepanel",
    postMessage: vi.fn(),
    onMessage: { addListener: (cb: (msg: Record<string, unknown>) => void) => { messageListener = cb; } },
    onDisconnect: { addListener: noop },
  };
  onConnectListener!(port);
  // Send initWindow which triggers tabs.query — mock it to return the gmail tab
  const tabsQuery = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome.tabs.query;
  tabsQuery.mockResolvedValueOnce([{ id: gmailTabId, url: gmailTabUrl, windowId: 1 }]);
  messageListener!({ type: "initWindow", windowId: 1 });
  return {
    port,
    sendMessage: (msg: Record<string, unknown>) => { messageListener!(msg); },
  };
}

describe("selectionChanged handler", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("selectionChanged with labelId triggers query + navigation + labelResult response", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Work/Projects", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 3, coLabelCounts: { INBOX: 2 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    // Wait for initWindow to complete
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.queryLabel).toHaveBeenCalledWith("Label_1", false, null);
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("label") });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 3, seq: 1 }));
  });

  it("selectionChanged with null labelId navigates to #all and responds with empty result", async () => {
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: null, includeChildren: false, scope: null, scopeTimestamp: null, seq: 2 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: "https://mail.google.com/mail/u/0/#all" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "labelResult", labelId: null, count: 0, coLabelCounts: {}, seq: 2 });
  });

  it("selectionChanged with includeChildren resolves descendant names for Gmail URL", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Work/Projects", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 5, coLabelCounts: {} });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: true, scope: null, scopeTimestamp: null, seq: 3 });
    await new Promise(r => setTimeout(r, 0));

    // URL should contain both label names in an OR query
    const url = tabsUpdateMock.mock.calls[0][1].url as string;
    expect(url).toContain("search");
    expect(url).toContain("work");
    expect(url).toContain("work-projects");
  });

  it("selectionChanged responds with error when queryLabel rejects but still navigates Gmail", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("query failed"));
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 5 });
    await new Promise(r => setTimeout(r, 0));

    // Navigation should still happen despite query failure
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", error: true, seq: 5 }));
  });

  it("selectionChanged recovers labels via loadLabels when getLabels returns empty", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    // Initially empty (simulating prior fetchLabels failure), then populated after loadLabels
    (cacheManager.getLabels as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([])
      .mockReturnValue(labels);
    (cacheManager.loadLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 2, coLabelCounts: {} });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 10 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.loadLabels).toHaveBeenCalled();
    // Navigation should use the recovered label name, not fall back to #all
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 2, seq: 10 }));
  });

  it("selectionChanged returns error when label recovery fails and includeChildren is true", async () => {
    // getLabels returns empty even after loadLabels attempt (simulating persistent failure)
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (cacheManager.loadLabels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: true, scope: null, scopeTimestamp: null, seq: 11 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.loadLabels).toHaveBeenCalled();
    // Navigation should be skipped (label can't be resolved)
    expect(tabsUpdateMock).not.toHaveBeenCalled();
    // queryLabel should NOT be called — descendant resolution would silently degrade
    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
    // Should return error result instead of degraded counts
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 0, error: true, seq: 11 }));
  });

  it("selectionChanged with null labelId and scope navigates to scoped search", async () => {
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: null, includeChildren: false, scope: "2024/01/01", scopeTimestamp: null, seq: 4 });
    await new Promise(r => setTimeout(r, 0));

    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("search") });
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("after") });
  });
});

describe("filtersOff handler", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("filtersOff navigates to #inbox", async () => {
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    tabsUpdateMock.mockClear();

    sendMessage({ type: "filtersOff" });

    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: "https://mail.google.com/mail/u/0/#inbox" });
  });
});

describe("cache-complete re-query", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("pushes updated labelResult and countsReady when cache completes with active label", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 10, coLabelCounts: { INBOX: 5 } });
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ Label_1: { own: 10, inclusive: 10 }, INBOX: { own: 50, inclusive: 50 } });

    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    // Send selectionChanged to store the last selection
    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockClear();

    // Simulate cache completion via the progress callback captured at module load
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 15, coLabelCounts: { INBOX: 8 } });
    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });
    await new Promise(r => setTimeout(r, 0));

    // Should re-query with stored selection parameters
    expect(cacheManager.queryLabel).toHaveBeenCalledWith("Label_1", false, null);
    // Should push updated labelResult to sidepanel with seq from last selection
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 15, seq: 1 }));
    // Should push updated countsReady
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });

  it("does not re-query when cache completes with no active label", async () => {
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    // Send selectionChanged with null to deselect
    sendMessage({ type: "selectionChanged", labelId: null, includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockClear();

    // Simulate cache completion via the progress callback captured at module load
    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });
    await new Promise(r => setTimeout(r, 0));

    // Should NOT re-query (no active label)
    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
    // Should still push countsReady
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });

  it("uses scope from fetchCounts when cache completes with no prior selectionChanged", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000; // 1 month ago
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });

    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    // Sidepanel sends fetchCounts with scope (no selectionChanged sent because no active label)
    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 1 });
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockClear();
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 8, inclusive: 8 } });

    // Simulate cache completion — pushUpdatedResults should use the scope from fetchCounts
    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });
    await new Promise(r => setTimeout(r, 0));

    // getLabelCounts should be called (scope is set via ensureScopeFilter before the call)
    expect(cacheManager.getLabelCounts).toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });
});

describe("scope filter propagation", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("selectionChanged with scope triggers setScopeFilter before queryLabel", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 3, coLabelCounts: {} });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: "2024/01/01", scopeTimestamp, seq: 1 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.setScopeFilter).toHaveBeenCalledWith(scopeTimestamp);
    expect(cacheManager.queryLabel).toHaveBeenCalledWith("Label_1", false, scopeTimestamp);
    // setScopeFilter should be called before queryLabel
    const setScopeOrder = (cacheManager.setScopeFilter as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const queryOrder = (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(setScopeOrder).toBeLessThan(queryOrder);
  });

  it("fetchCounts with scope triggers setScopeFilter before getLabelCounts", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 1 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.setScopeFilter).toHaveBeenCalledWith(scopeTimestamp);
    expect(cacheManager.getLabelCounts).toHaveBeenCalled();
    // setScopeFilter should be called before getLabelCounts
    const setScopeOrder = (cacheManager.setScopeFilter as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const countsOrder = (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(setScopeOrder).toBeLessThan(countsOrder);
  });

  it("same scope does not re-trigger setScopeFilter", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 3, coLabelCounts: {} });
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    // First call with scope
    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: "2024/01/01", scopeTimestamp, seq: 1 });
    await new Promise(r => setTimeout(r, 0));
    expect(cacheManager.setScopeFilter).toHaveBeenCalledTimes(1);

    // Second call with same scope — should NOT call setScopeFilter again
    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 2 });
    await new Promise(r => setTimeout(r, 0));
    expect(cacheManager.setScopeFilter).toHaveBeenCalledTimes(1);

    // Third call with different scope — SHOULD call setScopeFilter
    const newScope = Date.now() - 60 * 24 * 60 * 60 * 1000;
    sendMessage({ type: "fetchCounts", scopeTimestamp: newScope, seq: 3 });
    await new Promise(r => setTimeout(r, 0));
    expect(cacheManager.setScopeFilter).toHaveBeenCalledTimes(2);
    expect(cacheManager.setScopeFilter).toHaveBeenLastCalledWith(newScope);
  });

  it("null scope clears the scope filter", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    // Set a scope
    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 1 });
    await new Promise(r => setTimeout(r, 0));
    expect(cacheManager.setScopeFilter).toHaveBeenCalledWith(scopeTimestamp);

    // Clear scope with null
    sendMessage({ type: "fetchCounts", scopeTimestamp: null, seq: 2 });
    await new Promise(r => setTimeout(r, 0));
    expect(cacheManager.setScopeFilter).toHaveBeenCalledWith(null);
  });
});

