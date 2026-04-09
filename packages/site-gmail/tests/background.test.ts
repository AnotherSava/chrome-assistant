import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock cache-manager module before background.ts imports it
vi.mock("../src/cache-manager.js", () => {
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockStop = vi.fn();
  const mockIsOrchestratorRunning = vi.fn().mockReturnValue(false);
  const mockSetFilterConfig = vi.fn();
  const mockGetFilterConfig = vi.fn().mockReturnValue({ labelId: null, includeChildren: false, scopeTimestamp: null });
  const mockWakeOrchestrator = vi.fn();
  const mockQueryLabel = vi.fn().mockResolvedValue({ labelId: "INBOX", count: 5, coLabelCounts: { STARRED: 1 } });
  const mockGetLabelCounts = vi.fn().mockResolvedValue({ INBOX: { own: 10, inclusive: 10 } });
  const mockGetLabels = vi.fn().mockReturnValue([]);
  const mockSetLabels = vi.fn();
  const mockSetProgressCallback = vi.fn();
  const mockUpdateSystemLabelSettings = vi.fn();
  const mockWhenReady = vi.fn().mockResolvedValue(undefined);
  const mockLoadLabels = vi.fn().mockResolvedValue(undefined);
  const mockWaitForScopeReady = vi.fn().mockResolvedValue(true);
  const mockRequestScopeFetch = vi.fn();
  return {
    CacheManager: vi.fn().mockImplementation(() => ({
      start: mockStart,
      stop: mockStop,
      isOrchestratorRunning: mockIsOrchestratorRunning,
      setFilterConfig: mockSetFilterConfig,
      getFilterConfig: mockGetFilterConfig,
      wakeOrchestrator: mockWakeOrchestrator,
      queryLabel: mockQueryLabel,
      getLabelCounts: mockGetLabelCounts,
      getLabels: mockGetLabels,
      setLabels: mockSetLabels,
      setProgressCallback: mockSetProgressCallback,
      updateSystemLabelSettings: mockUpdateSystemLabelSettings,
      whenReady: mockWhenReady,
      loadLabels: mockLoadLabels,
      waitForScopeReady: mockWaitForScopeReady,
      requestScopeFetch: mockRequestScopeFetch,
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
  alarms: { create: alarmsCreateMock, clear: alarmsClearMock, get: vi.fn().mockResolvedValue(undefined), onAlarm: { addListener: noop } },
};

const { buildGmailUrl, startOrchestrator, _resetCacheState, cacheManager } = await import("../src/background.js");

/** Flush microtask queue and one macrotask — repeat to handle promise chains added by waitForScopeReady. */
async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

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

describe("startOrchestrator", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
  });

  it("starts orchestrator on first call", () => {
    startOrchestrator("/mail/u/0/");
    expect(cacheManager.start).toHaveBeenCalledWith("/mail/u/0/");
    expect(alarmsCreateMock).toHaveBeenCalledWith("cache-keepalive", { periodInMinutes: 0.4 });
  });

  it("does not restart for same account when already running", () => {
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    startOrchestrator("/mail/u/0/");
    expect(cacheManager.start).toHaveBeenCalledTimes(1);
    // Simulate orchestrator now running
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startOrchestrator("/mail/u/0/");
    expect(cacheManager.start).toHaveBeenCalledTimes(1);
  });

  it("restarts on account change", () => {
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    startOrchestrator("/mail/u/0/");
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startOrchestrator("/mail/u/1/");
    // start() internally handles stopping the previous loop
    expect(cacheManager.start).toHaveBeenCalledWith("/mail/u/1/");
  });

  it("sets initial filter config when scope is provided", () => {
    const scope = Date.now() - 7 * 24 * 60 * 60 * 1000;
    startOrchestrator("/mail/u/0/", scope);
    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: null, includeChildren: false, scopeTimestamp: scope });
  });

  it("does not set filter config when scope is undefined", () => {
    startOrchestrator("/mail/u/0/");
    expect(cacheManager.setFilterConfig).not.toHaveBeenCalled();
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

  it("selectionChanged with labelId triggers setFilterConfig + query + navigation + labelResult response", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Work/Projects", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 3, coLabelCounts: { INBOX: 2 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await flush();

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: "Label_1", includeChildren: false, scopeTimestamp: null });
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

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: null, includeChildren: false, scopeTimestamp: null });
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

    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", error: true, seq: 5 }));
  });

  it("selectionChanged recovers labels via loadLabels when getLabels returns empty", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
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
    await flush();

    expect(cacheManager.loadLabels).toHaveBeenCalled();
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 2, seq: 10 }));
  });

  it("selectionChanged returns error when label recovery fails and includeChildren is true", async () => {
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (cacheManager.loadLabels as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: true, scope: null, scopeTimestamp: null, seq: 11 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.loadLabels).toHaveBeenCalled();
    expect(tabsUpdateMock).not.toHaveBeenCalled();
    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
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

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await flush();
    port.postMessage.mockClear();
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockClear();

    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 15, coLabelCounts: { INBOX: 8 } });
    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10 });
    await flush();

    expect(cacheManager.queryLabel).toHaveBeenCalledWith("Label_1", false, null);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "labelResult", labelId: "Label_1", count: 15, seq: 1 }));
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });

  it("does not re-query when cache completes with no active label", async () => {
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "selectionChanged", labelId: null, includeChildren: false, scope: null, scopeTimestamp: null, seq: 1 });
    await flush();
    port.postMessage.mockClear();
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockClear();

    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10 });
    await flush();

    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });

  it("uses scope from fetchCounts when cache completes with no prior selectionChanged", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });

    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 1 });
    await flush();
    port.postMessage.mockClear();
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockClear();
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 8, inclusive: 8 } });

    progressCallback({ phase: "complete", labelsTotal: 10, labelsDone: 10 });
    await flush();

    expect(cacheManager.getLabelCounts).toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "countsReady" }));
  });
});

describe("orchestrator filter config propagation", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("selectionChanged with scope sets filter config with scope", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ labelId: "Label_1", count: 3, coLabelCounts: {} });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", includeChildren: false, scope: "2024/01/01", scopeTimestamp, seq: 1 });
    await flush();

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: "Label_1", includeChildren: false, scopeTimestamp });
    expect(cacheManager.queryLabel).toHaveBeenCalledWith("Label_1", false, scopeTimestamp);
  });

  it("fetchCounts with scope updates filter config", async () => {
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    (cacheManager.getLabelCounts as ReturnType<typeof vi.fn>).mockResolvedValue({ INBOX: { own: 5, inclusive: 5 } });
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    sendMessage({ type: "fetchCounts", scopeTimestamp, seq: 1 });
    await flush();

    expect(cacheManager.setFilterConfig).toHaveBeenCalled();
    expect(cacheManager.getLabelCounts).toHaveBeenCalledWith(undefined, scopeTimestamp);
  });

  it("syncSettings updates system label settings and wakes orchestrator", async () => {
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "syncSettings", showStarred: true, showImportant: false });

    expect(cacheManager.updateSystemLabelSettings).toHaveBeenCalledWith(true, false);
    expect(cacheManager.wakeOrchestrator).toHaveBeenCalled();
  });

  it("syncSettings does not wake orchestrator when not running", async () => {
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "syncSettings", showStarred: true, showImportant: false });

    expect(cacheManager.updateSystemLabelSettings).toHaveBeenCalledWith(true, false);
    expect(cacheManager.wakeOrchestrator).not.toHaveBeenCalled();
  });
});

describe("_resetCacheState", () => {
  it("stops orchestrator and clears state", () => {
    startOrchestrator("/mail/u/0/");
    _resetCacheState();
    expect(cacheManager.stop).toHaveBeenCalled();
    // Starting again should work (not be blocked by stale state)
    vi.clearAllMocks();
    startOrchestrator("/mail/u/0/");
    expect(cacheManager.start).toHaveBeenCalledWith("/mail/u/0/");
  });
});
