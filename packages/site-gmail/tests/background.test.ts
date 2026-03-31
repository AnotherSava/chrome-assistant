import { describe, it, expect } from "vitest";

// Mock chrome APIs used at module top level — must be set before import
const noop = () => {};
(globalThis as Record<string, unknown>).chrome = {
  storage: { session: { get: noop } },
  sidePanel: { setPanelBehavior: noop },
  commands: { getAll: noop, onCommand: { addListener: noop } },
  action: { setTitle: noop, onClicked: { addListener: noop } },
  runtime: { onConnect: { addListener: noop } },
  tabs: { onUpdated: { addListener: noop }, onActivated: { addListener: noop } },
  identity: { getAuthToken: noop, removeCachedAuthToken: noop },
};

const { buildGmailUrl } = await import("../src/background.js");

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
