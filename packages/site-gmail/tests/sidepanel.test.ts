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
const { handleMessage, scopeToTimestamp, setIncludeChildren, setShowCounts, setShowStarred, setShowImportant } = await import("../src/sidepanel.js");

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
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 42, coLabelCounts: { Label_2: 1 } });

    // Content should show Work and Personal but not Archive
    const content = document.getElementById("content");
    expect(content?.innerHTML).toContain("Work");
    expect(content?.innerHTML).toContain("Personal");
    expect(content?.innerHTML).not.toContain("Archive");
  });

  it("sends selectionChanged when label is selected", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_X", name: "TestLabel", type: "user" }, { id: "Label_Y", name: "Other", type: "user" }] });
    vi.clearAllMocks();

    // Use a fresh label ID to avoid toggling off a previously active label
    const link = document.querySelector('[data-label-id="Label_X"]') as HTMLAnchorElement;
    link?.click();

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "selectionChanged", labelId: "Label_X" }));
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
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 5, coLabelCounts: {} });

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
    handleMessage({ type: "labelResult", labelId: "Label_999", count: 0, coLabelCounts: {} });

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

  it("does not re-query from sidepanel when cache completes (service worker handles it)", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [{ id: "Label_1", name: "Work", type: "user" }] });

    // Select a label
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();
    vi.clearAllMocks();

    // Cache completes — sidepanel should NOT send selectionChanged (service worker re-queries internally)
    handleMessage({ type: "cacheState", phase: "complete", labelsTotal: 10, labelsDone: 10, datesTotal: 0, datesDone: 0 });

    const selectionMessages = mockPostMessage.mock.calls.filter((c: unknown[]) => (c[0] as Record<string, unknown>).type === "selectionChanged");
    expect(selectionMessages).toHaveLength(0);
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
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 0, coLabelCounts: {}, error: true });

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
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 0, coLabelCounts: {}, error: true });

    // Then success — error should be cleared
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 10, coLabelCounts: { Label_2: 1 } });
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

describe("sendSelectionChanged with include children", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
  });

  afterEach(() => {
    setIncludeChildren(true);
  });

  it("sends selectionChanged with includeChildren true when setting is on", () => {
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
      type: "selectionChanged",
      labelId: "L1",
      includeChildren: true,
    }));
  });

  it("sends selectionChanged with includeChildren false when setting is off", () => {
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
      type: "selectionChanged",
      labelId: "L1",
      includeChildren: false,
    }));
  });
});

describe("label counts rendering", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
    setShowCounts(true);
  });

  afterEach(() => {
    setShowCounts(true);
  });

  it("renderLabelTree includes count spans when labelsReady has counts", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];
    const counts = {
      Label_1: { own: 10, inclusive: 10 },
      Label_2: { own: 5, inclusive: 5 },
    };
    handleMessage({ type: "labelsReady", labels, counts });

    const content = document.getElementById("content");
    const countSpans = content?.querySelectorAll(".label-count");
    expect(countSpans?.length).toBe(2);
    // Labels are sorted alphabetically: Personal (5), Work (10)
    expect(countSpans?.[0]?.textContent).toBe(" (5)");
    expect(countSpans?.[1]?.textContent).toBe(" (10)");
  });

  it("does not show counts when showCounts is disabled", () => {
    setShowCounts(false);
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
    ];
    const counts = { Label_1: { own: 10, inclusive: 10 } };
    handleMessage({ type: "labelsReady", labels, counts });

    const content = document.getElementById("content");
    const countSpans = content?.querySelectorAll(".label-count");
    expect(countSpans?.length).toBe(0);
  });

  it("shows co-label counts when a label is selected", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ];
    const counts = {
      Label_1: { own: 10, inclusive: 10 },
      Label_2: { own: 5, inclusive: 5 },
    };
    handleMessage({ type: "labelsReady", labels, counts });

    // Select Work label
    const workLink = document.querySelector('[data-label-id="Label_1"]') as HTMLAnchorElement;
    workLink?.click();

    // Simulate labelResult with co-label counts
    handleMessage({ type: "labelResult", labelId: "Label_1", count: 10, coLabelCounts: { Label_2: 3 } });

    const content = document.getElementById("content");
    const countSpans = content?.querySelectorAll(".label-count");
    // Work (10) and Personal (3) should have counts
    expect(countSpans?.length).toBe(2);
    // Work label shows the query result count
    const workCount = content?.querySelector('[data-label-id="Label_1"] .label-count');
    expect(workCount?.textContent).toBe(" (10)");
    // Personal shows co-label count
    const personalCount = content?.querySelector('[data-label-id="Label_2"] .label-count');
    expect(personalCount?.textContent).toBe(" (3)");
  });

  it("updates displayed counts when countsReady arrives after labelsReady", () => {
    // Fresh account to clear stale state
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/99/" });
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    handleMessage({ type: "labelsReady", labels: [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "Label_2", name: "Personal", type: "user" },
    ] });

    // No counts yet (labelsReady has no counts field)
    expect(document.querySelectorAll(".label-count").length).toBe(0);

    // countsReady arrives — counts appear via in-place update
    handleMessage({ type: "countsReady", counts: { Label_1: { own: 42, inclusive: 42 }, Label_2: { own: 7, inclusive: 7 } } });
    const countSpans = document.querySelectorAll(".label-count");
    expect(countSpans.length).toBe(2);
  });
});

describe("system labels in label tree", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
    setShowStarred(false);
    setShowImportant(false);
  });

  afterEach(() => {
    setShowStarred(false);
    setShowImportant(false);
  });

  it("system labels appear before user labels when visible", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "Label_1", name: "Work", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_2", name: "Personal", type: "user" },
      { id: "SENT", name: "SENT", type: "system" },
    ];
    handleMessage({ type: "labelsReady", labels });

    const content = document.getElementById("content");
    const links = content?.querySelectorAll(".label-link");
    expect(links?.length).toBe(4);
    // System labels should appear first in fixed order: INBOX, SENT
    expect(links?.[0]?.getAttribute("data-label-id")).toBe("INBOX");
    expect(links?.[1]?.getAttribute("data-label-id")).toBe("SENT");
    // Then user labels alphabetically: Personal, Work
    expect(links?.[2]?.getAttribute("data-label-id")).toBe("Label_2");
    expect(links?.[3]?.getAttribute("data-label-id")).toBe("Label_1");
  });

  it("STARRED and IMPORTANT hidden when settings are off", () => {
    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "STARRED", name: "STARRED", type: "system" },
      { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    const content = document.getElementById("content");
    const labelIds = Array.from(content?.querySelectorAll(".label-link") ?? []).map((l) => l.getAttribute("data-label-id"));
    expect(labelIds).toContain("INBOX");
    expect(labelIds).toContain("SENT");
    expect(labelIds).not.toContain("STARRED");
    expect(labelIds).not.toContain("IMPORTANT");
    expect(labelIds).toContain("Label_1");
  });

  it("STARRED and IMPORTANT visible when settings are on and co-label rules allow", () => {
    setShowStarred(true);
    setShowImportant(true);

    handleMessage({ type: "resultsReady", accountPath: "/mail/u/0/" });
    const labels = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "STARRED", name: "STARRED", type: "system" },
      { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];
    handleMessage({ type: "labelsReady", labels });

    const content = document.getElementById("content");
    const links = content?.querySelectorAll(".label-link");
    const labelIds = Array.from(links ?? []).map((l) => l.getAttribute("data-label-id"));
    // All system labels visible in fixed order
    expect(labelIds).toEqual(["INBOX", "SENT", "STARRED", "IMPORTANT", "Label_1"]);
  });
});
