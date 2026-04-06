// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Minimal DOM setup for sidepanel.ts module-level code
function setupDOM(): void {
  document.body.innerHTML = `
    <div id="tab-bar"><div class="tab" data-tab="summary">Summary</div><div class="tab active" data-tab="filters">Filters</div></div>
    <div id="content"></div>
    <div id="zoom-indicator"></div>
    <button id="btn-zoom-out"></button>
    <button id="btn-zoom-in"></button>
    <button id="btn-pin"></button>
    <div id="pin-dropdown" style="display:none"></div>
    <button id="btn-display"></button>
    <div id="display-panel" style="display:none"></div>
    <button id="btn-help"></button>
  `;
}

// Mock chrome APIs before importing sidepanel
const mockPostMessage = vi.fn();
const mockPort = {
  name: "sidepanel",
  postMessage: mockPostMessage,
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
};

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    connect: vi.fn(() => mockPort),
    id: "test-extension-id",
  },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
  sidePanel: { setPanelBehavior: vi.fn() },
  commands: { getAll: vi.fn((cb: Function) => cb([])) },
  action: { setTitle: vi.fn(), onClicked: { addListener: vi.fn() } },
  tabs: { create: vi.fn(), query: vi.fn(), onUpdated: { addListener: vi.fn() }, onActivated: { addListener: vi.fn() } },
  windows: { getCurrent: vi.fn().mockResolvedValue({ id: 1 }) },
  identity: { getAuthToken: vi.fn(), removeCachedAuthToken: vi.fn() },
  alarms: { create: vi.fn(), clear: vi.fn().mockResolvedValue(undefined), onAlarm: { addListener: vi.fn() } },
};

setupDOM();
const { handleMessage, scopeToTimestamp, getDescendantIds, setIncludeChildren } = await import("../src/sidepanel.js");

describe("handleMessage", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
  });

  it("handles resultsReady by requesting labels", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    // Should post fetchLabels to background
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "fetchLabels" }));
  });

  it("handles labelsReady by rendering labels", () => {
    // First set up as on Gmail
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    vi.clearAllMocks();

    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    // Content should now contain label links
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
  });

  it("handles notOnGmail by showing help", () => {
    handleMessage({ type: "notOnGmail" });
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("help");
  });

  it("handles cacheState updates and displays progress", () => {
    // Set up as on Gmail with labels
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    // Receive cache progress
    handleMessage({ type: "cacheState", phase: "labels", labelsTotal: 10, labelsDone: 3, datesTotal: 0, datesDone: 0 });

    const progress = document.getElementById("cache-progress");
    expect(progress?.innerHTML).toContain("labels 3/10");
  });

  it("handles cacheState dates phase", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    handleMessage({ type: "cacheState", phase: "dates", labelsTotal: 10, labelsDone: 10, datesTotal: 500, datesDone: 200 });

    const progress = document.getElementById("cache-progress");
    expect(progress?.innerHTML).toContain("dates 200/500");
  });

  it("handles cacheState complete phase", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    handleMessage({ type: "cacheState", phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });

    const progress = document.getElementById("cache-progress");
    expect(progress?.innerHTML).toBe("");
  });

  it("handles labelResult by filtering displayed labels", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
      { id: "Label_3", name: "Archive", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    // Click "Work" label to select it
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();

    // Simulate background returning labelResult — only Label_2 co-occurs
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 42, coLabels: ["Label_2"] });

    // Content should show Work and Personal but not Archive
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
    expect(content?.innerHTML).not.toContain("Archive");
  });

  it("sends queryLabel when label is selected", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_X", name: "TestLabel", type: "user" }, { id: "Label_Y", name: "Other", type: "user" }] });
    vi.clearAllMocks();

    // Use a fresh label ID to avoid toggling off a previously active label
    const link = document.querySelector('[data-label-id="Label_X"]') as HTMLAnchorElement;
    link?.click();

    // Both applyFilters and queryLabel should be sent
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "applyFilters" }));
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "queryLabel", labelId: "Label_X", location: "inbox" }));
  });

  it("deselecting a label shows all labels", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    // Select then deselect
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 5, coLabels: [] });

    // After labelResult, Personal might be hidden. Now deselect:
    const workLink2 = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink2?.click();

    // Both labels should be visible again
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
  });

  it("ignores labelResult for non-active label", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    // Select Work
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();

    // Result arrives for a different label (stale result) — should be ignored
    handleMessage({ type: "labelResult", labelId: "Label_999", count: 0, coLabels: [] });

    // Both labels should still be visible (no filtering applied from stale result)
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
  });

  it("handles account change by clearing state", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    // Switch account
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/1/" });

    // Should request new labels
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "fetchLabels" }));
  });

  it("re-queries active label when cache completes", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    // Select a label
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();
    vi.clearAllMocks();

    // Cache completes — should trigger re-query
    handleMessage({ type: "cacheState", phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "queryLabel", labelId: "Label_1" }));
  });

  it("handles labelsError gracefully when no labels cached", () => {
    // Force a fresh Gmail state by switching accounts (clears cachedLabels)
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/99/" });
    // Now labelsError should show error since cachedLabels is null after account switch
    handleMessage({ type: "labelsError" });

    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Loading labels...");
  });

  it("handles fetchError gracefully", () => {
    handleMessage({ type: "fetchError" });

    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Failed to fetch emails");
  });

  it("shows error status in cache progress when labelResult has error", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Personal", type: "user" }] });

    // Select Work label
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();

    // Simulate error response from background
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 0, coLabels: [], error: true });

    const progress = document.getElementById("cache-progress");
    expect(progress?.innerHTML).toContain("query failed");

    // Both labels should still be visible (unfiltered)
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
  });

  it("clears error status when a successful labelResult arrives", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Personal", type: "user" }] });

    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();

    // Error first
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 0, coLabels: [], error: true });

    // Then success — error should be cleared
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 10, coLabels: ["Label_2"] });
    const progress = document.getElementById("cache-progress");
    expect(progress?.innerHTML).not.toContain("query failed");
  });
});

describe("scopeToTimestamp", () => {
  it("returns null for 'any'", () => {
    expect(scopeToTimestamp("any")).toBeNull();
  });

  it("returns a timestamp for '1w'", () => {
    const ts = scopeToTimestamp("1w");
    expect(ts).toBeTypeOf("number");
    expect(ts).toBeLessThan(Date.now());
    expect(ts! > Date.now() - 8 * 86400000).toBe(true);
  });

  it("returns a timestamp for '1y'", () => {
    const ts = scopeToTimestamp("1y");
    expect(ts).toBeTypeOf("number");
    // Roughly 1 year ago
    const oneYearAgo = Date.now() - 366 * 86400000;
    expect(ts! > oneYearAgo).toBe(true);
  });

  it("returns null for unknown scope", () => {
    expect(scopeToTimestamp("unknown")).toBeNull();
  });
});

describe("getDescendantIds", () => {
  it("returns all descendants for a nested label", () => {
    const labels = [
      { id: "L1", name: "Games", type: "user" },
      { id: "L2", name: "Games/18xx", type: "user" },
      { id: "L3", name: "Games/Chess", type: "user" },
      { id: "L4", name: "Games/Chess/Online", type: "user" },
      { id: "L5", name: "Work", type: "user" },
    ];
    const descendants = getDescendantIds("L1", labels);
    expect(descendants).toContain("L2");
    expect(descendants).toContain("L3");
    expect(descendants).toContain("L4");
    expect(descendants).not.toContain("L1");
    expect(descendants).not.toContain("L5");
  });

  it("returns empty for leaf label", () => {
    const labels = [
      { id: "L1", name: "Games", type: "user" },
      { id: "L2", name: "Games/18xx", type: "user" },
      { id: "L3", name: "Work", type: "user" },
    ];
    const descendants = getDescendantIds("L2", labels);
    expect(descendants).toEqual([]);
  });

  it("returns empty for label with no children in the tree", () => {
    const labels = [
      { id: "L1", name: "Work", type: "user" },
      { id: "L2", name: "Personal", type: "user" },
    ];
    const descendants = getDescendantIds("L1", labels);
    expect(descendants).toEqual([]);
  });
});

describe("sendQueryLabel with include children", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
  });

  afterEach(() => {
    setIncludeChildren(true);
  });

  it("sends array with descendants when setting is on", () => {
    // Default includeChildren is true (from loadSetting default)
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [
      { id: "L1", name: "Games", type: "user" },
      { id: "L2", name: "Games/18xx", type: "user" },
      { id: "L3", name: "Games/Chess", type: "user" },
      { id: "L4", name: "Work", type: "user" },
    ] });
    vi.clearAllMocks();

    // Click parent label "Games"
    const link = document.querySelector('[data-label-id="L1"]') as HTMLAnchorElement;
    link?.click();

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "queryLabel",
      labelIds: expect.arrayContaining(["L1", "L2", "L3"]),
      labelId: "L1",
    }));

    // Also verify applyFilters message includes descendant label names
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "applyFilters",
      labelName: expect.arrayContaining(["Games", "Games/18xx", "Games/Chess"]),
    }));
  });

  it("sends single-element array when setting is off", () => {
    setIncludeChildren(false);

    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [
      { id: "L1", name: "Games", type: "user" },
      { id: "L2", name: "Games/18xx", type: "user" },
      { id: "L3", name: "Work", type: "user" },
    ] });

    // Deselect any previously active label (state persists across tests)
    const activeLink = document.querySelector('.label-link.active') as HTMLAnchorElement;
    if (activeLink) activeLink.click();
    vi.clearAllMocks();

    // Click parent label "Games"
    const link = document.querySelector('[data-label-id="L1"]') as HTMLAnchorElement;
    link?.click();

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "queryLabel",
      labelIds: ["L1"],
      labelId: "L1",
    }));

    // Verify applyFilters sends single label name (not array) when children disabled
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "applyFilters",
      labelName: "Games",
    }));
  });
});
