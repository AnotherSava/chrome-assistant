import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @core/settings module — background.ts imports loadSettings and onSettingChanged
vi.mock("@core/settings.js", () => ({
  loadSettings: vi.fn().mockResolvedValue({}),
  onSettingChanged: vi.fn(),
  saveSetting: vi.fn(),
}));

// Mock cache-manager module before background.ts imports it
vi.mock("../src/cache-manager.js", () => {
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockStop = vi.fn();
  const mockIsOrchestratorRunning = vi.fn().mockReturnValue(false);
  const mockSetFilterConfig = vi.fn();
  const mockGetFilterConfig = vi.fn().mockReturnValue({ labelId: null, includeChildren: true, scopeTimestamp: null });
  const mockWakeOrchestrator = vi.fn();
  const mockQueryLabel = vi.fn().mockResolvedValue({ labelId: "INBOX", count: 5, coLabelCounts: { STARRED: 1 } });
  const mockGetLabelCounts = vi.fn().mockResolvedValue({ INBOX: { own: 10, inclusive: 10 } });
  const mockGetLabels = vi.fn().mockReturnValue([]);
  const mockSetLabels = vi.fn();
  const mockSetProgressCallback = vi.fn();
  const mockSetResultCallback = vi.fn();
  const mockUpdateSystemLabelSettings = vi.fn();

  const mockLoadLabels = vi.fn().mockResolvedValue(undefined);
  const mockIsScopeReady = vi.fn().mockReturnValue(true);
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
      setResultCallback: mockSetResultCallback,
      updateSystemLabelSettings: mockUpdateSystemLabelSettings,
      loadLabels: mockLoadLabels,
      isScopeReady: mockIsScopeReady,
      requestScopeFetch: mockRequestScopeFetch,
      setConcurrency: vi.fn(),
      reset: vi.fn().mockResolvedValue(undefined),
      isInitialBuildComplete: vi.fn().mockReturnValue(true),
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
  storage: { session: { get: noop, set: noop }, local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() }, onChanged: { addListener: noop } },
  sidePanel: { setPanelBehavior: noop },
  commands: { getAll: noop, onCommand: { addListener: noop } },
  action: { setTitle: noop, onClicked: { addListener: noop } },
  runtime: { onConnect: { addListener: (cb: (port: unknown) => void) => { onConnectListener = cb; } } },
  tabs: { onUpdated: { addListener: noop }, onActivated: { addListener: noop }, query: vi.fn(), update: tabsUpdateMock, get: vi.fn() },
  identity: { getAuthToken: noop, removeCachedAuthToken: noop },
  alarms: { create: alarmsCreateMock, clear: alarmsClearMock, get: vi.fn().mockResolvedValue(undefined), onAlarm: { addListener: noop } },
};

const { buildGmailUrl, startOrchestrator, _resetCacheState, cacheManager } = await import("../src/background.js");

/** Flush microtask queue and one macrotask — repeat to handle async promise chains. */
async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

// Capture the result callback registered at module load time (before any clearAllMocks)
const resultCallback = (cacheManager.setResultCallback as ReturnType<typeof vi.fn>).mock.calls[0][0] as (result: Record<string, unknown>) => void;

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

  it("account switch invalidates in-flight per-port pushResultsForPort calls", async () => {
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (cacheManager.isScopeReady as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startOrchestrator("/mail/u/0/");
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Connect a port and give it a label selection so pushResultsForPort takes the
    // queryLabel async path (labelId !== null).
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await flush();
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "Label_1", name: "Work", type: "user" }]);
    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: null, scopeTimestamp: null });
    await flush();
    port.postMessage.mockClear();

    // Capture the queryLabel resolve so we can control when pushResultsForPort completes
    let resolveQuery!: (v: { count: number; coLabelCounts: Record<string, number> }) => void;
    (cacheManager.queryLabel as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(r => { resolveQuery = r; }));

    // Trigger relayResultPush with a different scope — the port's scopeTimestamp (null)
    // differs from the push's scope, so it goes through pushResultsForPort
    const differentScope = Date.now() - 99 * 24 * 60 * 60 * 1000;
    resultCallback({ labelId: "INBOX", count: 5, coLabelCounts: {}, counts: { INBOX: { own: 5, inclusive: 5 } }, filterConfig: { labelId: "INBOX", includeChildren: false, scopeTimestamp: differentScope } });

    // Now switch accounts — this should invalidate the in-flight push
    startOrchestrator("/mail/u/1/");

    // Resolve the deferred query — the stale push should be discarded
    resolveQuery({ count: 99, coLabelCounts: { STARRED: 10 } });
    await flush();

    // The port should NOT have received filterResults with stale data
    const staleMessages = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => {
      const msg = c[0] as Record<string, unknown>;
      return msg.type === "filterResults";
    });
    expect(staleMessages).toHaveLength(0);
  });

  it("sets initial filter config when scope is provided", () => {
    const scope = Date.now() - 7 * 24 * 60 * 60 * 1000;
    startOrchestrator("/mail/u/0/", scope);
    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: null, includeChildren: true, scopeTimestamp: scope }, true);
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

  it("selectionChanged with labelId triggers setFilterConfig + navigation", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Work/Projects", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: null, scopeTimestamp: null, seq: 1 });
    await flush();

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: "Label_1", includeChildren: true, scopeTimestamp: null });
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("label") });
    // Service worker no longer calls queryLabel directly — cache manager pushes results
    expect(cacheManager.queryLabel).not.toHaveBeenCalled();
  });

  it("selectionChanged with null labelId navigates to #all", async () => {
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "selectionChanged", labelId: null, scope: null, scopeTimestamp: null, seq: 2 });
    await new Promise(r => setTimeout(r, 0));

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: null, includeChildren: true, scopeTimestamp: null });
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: "https://mail.google.com/mail/u/0/#all" });
  });

  it("selectionChanged resolves descendant names for Gmail URL when includeChildren is on", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Work/Projects", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: null, scopeTimestamp: null, seq: 3 });
    await new Promise(r => setTimeout(r, 0));

    const url = tabsUpdateMock.mock.calls[0][1].url as string;
    expect(url).toContain("search");
    expect(url).toContain("work");
    expect(url).toContain("work-projects");
  });

  it("selectionChanged recovers labels via loadLabels when getLabels returns empty", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([])
      .mockReturnValue(labels);
    (cacheManager.loadLabels as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: null, scopeTimestamp: null, seq: 10 });
    await flush();

    expect(cacheManager.loadLabels).toHaveBeenCalled();
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
  });

  it("selectionChanged with null labelId and scope navigates to scoped search", async () => {
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "selectionChanged", labelId: null, scope: "2024/01/01", scopeTimestamp: null, seq: 4 });
    await new Promise(r => setTimeout(r, 0));

    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("search") });
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("after") });
  });

  it("Gmail navigation happens on selectionChanged, not on result push", async () => {
    const labels = [{ id: "Label_1", name: "Work", type: "user" }];
    (cacheManager.getLabels as ReturnType<typeof vi.fn>).mockReturnValue(labels);
    const { port, sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    tabsUpdateMock.mockClear();

    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: null, scopeTimestamp: null });
    await flush();

    // Navigation happened immediately with selectionChanged
    expect(tabsUpdateMock).toHaveBeenCalledWith(42, { url: expect.stringContaining("work") });
    tabsUpdateMock.mockClear();

    // Result push does NOT trigger navigation
    resultCallback({ labelId: "Label_1", count: 5, coLabelCounts: { INBOX: 2 }, counts: { Label_1: { own: 5, inclusive: 5 } }, filterConfig: { labelId: "Label_1", includeChildren: true, scopeTimestamp: null } });
    await flush();

    expect(tabsUpdateMock).not.toHaveBeenCalled();
    // But result is relayed to sidepanel
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "filterResults", labelId: "Label_1", count: 5 }));
  });
});

describe("result push relay", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("relays result push as filterResults to sidepanel", async () => {
    const { port } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    const filterConfig = { labelId: "Label_1", includeChildren: true, scopeTimestamp: null };
    resultCallback({ labelId: "Label_1", count: 10, coLabelCounts: { INBOX: 5 }, counts: { Label_1: { own: 10, inclusive: 10 }, INBOX: { own: 50, inclusive: 50 } }, filterConfig });

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "filterResults", labelId: "Label_1", count: 10, coLabelCounts: { INBOX: 5 }, counts: { Label_1: { own: 10, inclusive: 10 }, INBOX: { own: 50, inclusive: 50 } }, filterConfig }));
  });

  it("relays filterResults with null labelId", async () => {
    const { port } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port.postMessage.mockClear();

    const filterConfig = { labelId: null, includeChildren: true, scopeTimestamp: null };
    resultCallback({ labelId: null, count: 0, coLabelCounts: {}, counts: { INBOX: { own: 50, inclusive: 50 } }, filterConfig });

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "filterResults", labelId: null, counts: { INBOX: { own: 50, inclusive: 50 } } }));
  });

  it("relays to multiple connected ports", async () => {
    const { port: port1 } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    const { port: port2 } = createConnectedPort(43, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));
    port1.postMessage.mockClear();
    port2.postMessage.mockClear();

    const filterConfig = { labelId: "INBOX", includeChildren: true, scopeTimestamp: null };
    resultCallback({ labelId: "INBOX", count: 10, coLabelCounts: {}, counts: { INBOX: { own: 10, inclusive: 10 } }, filterConfig });

    expect(port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "filterResults" }));
    expect(port2.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "filterResults" }));
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
    const { sendMessage } = createConnectedPort(42, "https://mail.google.com/mail/u/0/#inbox");
    await new Promise(r => setTimeout(r, 0));

    sendMessage({ type: "selectionChanged", labelId: "Label_1", scope: "2024/01/01", scopeTimestamp, seq: 1 });
    await flush();

    expect(cacheManager.setFilterConfig).toHaveBeenCalledWith({ labelId: "Label_1", includeChildren: true, scopeTimestamp });
  });

});

describe("warm-connect with scope but no selection", () => {
  beforeEach(() => {
    _resetCacheState();
    vi.clearAllMocks();
    tabsUpdateMock.mockResolvedValue(undefined);
  });

  it("requests scope fetch on warm connect when scope is not ready", async () => {
    // Start orchestrator and mark it as running
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startOrchestrator("/mail/u/0/");
    (cacheManager.isScopeReady as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Connect a port with a saved scope (initWindow includes scopeTimestamp)
    let messageListener: ((msg: Record<string, unknown>) => void) | null = null;
    const port = {
      name: "sidepanel",
      postMessage: vi.fn(),
      onMessage: { addListener: (cb: (msg: Record<string, unknown>) => void) => { messageListener = cb; } },
      onDisconnect: { addListener: noop },
    };
    onConnectListener!(port);
    const tabsQuery = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome.tabs.query;
    tabsQuery.mockResolvedValueOnce([{ id: 42, url: "https://mail.google.com/mail/u/0/#inbox", windowId: 1 }]);
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    messageListener!({ type: "initWindow", windowId: 1 });
    messageListener!({ type: "selectionChanged", labelId: null, scopeTimestamp });
    await flush();

    expect(cacheManager.requestScopeFetch).toHaveBeenCalledWith(scopeTimestamp);
  });

  it("does not relay result push with mismatched scope to scoped port without selection", async () => {
    // Start orchestrator and mark it as running
    (cacheManager.isOrchestratorRunning as ReturnType<typeof vi.fn>).mockReturnValue(true);
    startOrchestrator("/mail/u/0/");
    (cacheManager.isScopeReady as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Connect a port with a saved scope but no label selection
    let messageListener: ((msg: Record<string, unknown>) => void) | null = null;
    const port = {
      name: "sidepanel",
      postMessage: vi.fn(),
      onMessage: { addListener: (cb: (msg: Record<string, unknown>) => void) => { messageListener = cb; } },
      onDisconnect: { addListener: noop },
    };
    onConnectListener!(port);
    const tabsQuery = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome.tabs.query;
    tabsQuery.mockResolvedValueOnce([{ id: 42, url: "https://mail.google.com/mail/u/0/#inbox", windowId: 1 }]);
    const scopeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    messageListener!({ type: "initWindow", windowId: 1 });
    messageListener!({ type: "selectionChanged", labelId: null, scopeTimestamp });
    await flush();
    port.postMessage.mockClear();

    // Push results with a DIFFERENT (null) scope — should NOT be relayed directly
    const filterConfig = { labelId: null, includeChildren: true, scopeTimestamp: null };
    resultCallback({ labelId: null, count: 0, coLabelCounts: {}, counts: { INBOX: { own: 50, inclusive: 50 } }, filterConfig });
    await flush();

    // The port should NOT receive a direct filterResults with scopeTimestamp: null
    // because its scope is different — pushResultsForPort should compute port-specific results
    const directRelay = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => {
      const msg = c[0] as Record<string, unknown>;
      if (msg.type !== "filterResults") return false;
      const fc = msg.filterConfig as Record<string, unknown>;
      return fc.scopeTimestamp === null;
    });
    expect(directRelay).toHaveLength(0);
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
