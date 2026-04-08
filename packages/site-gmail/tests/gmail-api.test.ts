import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSearchQuery, formatLabelForQuery } from "../src/gmail-api.js";

describe("buildSearchQuery", () => {
  it("returns empty string with no filters", () => {
    expect(buildSearchQuery(null, null)).toBe("");
  });

  it("adds label filter with name escaping for user labels", () => {
    expect(buildSearchQuery("Work/Projects", null)).toBe('label:"work-projects"');
  });

  it("escapes quotes in label names", () => {
    expect(buildSearchQuery('My "Label"', null)).toBe('label:"my-label"');
  });

  it("converts spaces to dashes in labels", () => {
    expect(buildSearchQuery("My Label", null)).toBe('label:"my-label"');
  });

  it("uses in:inbox for INBOX system label", () => {
    expect(buildSearchQuery("INBOX", null)).toBe("in:inbox");
  });

  it("uses in:sent for SENT system label", () => {
    expect(buildSearchQuery("SENT", null)).toBe("in:sent");
  });

  it("uses in:starred for STARRED system label", () => {
    expect(buildSearchQuery("STARRED", null)).toBe("in:starred");
  });

  it("uses in:important for IMPORTANT system label", () => {
    expect(buildSearchQuery("IMPORTANT", null)).toBe("in:important");
  });

  it("adds after:scope when provided", () => {
    expect(buildSearchQuery("INBOX", "2024/01/01")).toBe("in:inbox after:2024/01/01");
  });

  it("adds before:date when provided", () => {
    expect(buildSearchQuery(null, null, "2024/06/01")).toBe("before:2024/06/01");
  });

  it("combines label, scope, and beforeDate", () => {
    const result = buildSearchQuery("Work", "2024/01/01", "2024/06/01");
    expect(result).toBe('label:"work" after:2024/01/01 before:2024/06/01');
  });

  it("omits beforeDate when null", () => {
    const result = buildSearchQuery("Work", "2024/01/01", null);
    expect(result).toBe('label:"work" after:2024/01/01');
  });

  it("omits scope when null", () => {
    const result = buildSearchQuery("Reports", null);
    expect(result).toBe('label:"reports"');
  });

  it("produces single label format for single-element array", () => {
    expect(buildSearchQuery(["Work"], null)).toBe('label:"work"');
  });

  it("produces OR-grouped format for multiple labels", () => {
    const result = buildSearchQuery(["Games", "Games/18xx", "Games/Chess"], null);
    expect(result).toBe('{label:"games" OR label:"games-18xx" OR label:"games-chess"}');
  });

  it("combines multiple labels with scope and beforeDate", () => {
    const result = buildSearchQuery(["Work", "Work/Projects"], "2024/01/01", "2024/06/01");
    expect(result).toBe('{label:"work" OR label:"work-projects"} after:2024/01/01 before:2024/06/01');
  });

  it("mixes system and user labels in OR group", () => {
    const result = buildSearchQuery(["INBOX", "Work"], null);
    expect(result).toBe('{in:inbox OR label:"work"}');
  });

  it("system label with scope produces in: with after:", () => {
    const result = buildSearchQuery("SENT", "2024/01/01");
    expect(result).toBe("in:sent after:2024/01/01");
  });
});


describe("formatLabelForQuery", () => {
  it("lowercases and quotes label names", () => {
    expect(formatLabelForQuery("INBOX")).toBe('"inbox"');
  });

  it("replaces slashes with dashes", () => {
    expect(formatLabelForQuery("Work/Projects")).toBe('"work-projects"');
  });

  it("replaces spaces with dashes", () => {
    expect(formatLabelForQuery("My Label")).toBe('"my-label"');
  });

  it("strips quotes from label names", () => {
    expect(formatLabelForQuery('My "Special" Label')).toBe('"my-special-label"');
  });
});

describe("fetchLabelMessageIds", () => {
  let capturedUrls: string[];

  beforeEach(() => {
    capturedUrls = [];
    vi.stubGlobal("chrome", { identity: { getAuthToken: vi.fn().mockResolvedValue({ token: "test-token" }), removeCachedAuthToken: vi.fn() } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      capturedUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }] }) };
    }));
  });

  it("includes both after: and before: in query when scopeDate and beforeDate are set", async () => {
    const { fetchLabelMessageIds } = await import("../src/gmail-api.js");
    await fetchLabelMessageIds("INBOX", "2024/01/01", "2024/06/01");
    expect(capturedUrls.length).toBe(1);
    const url = capturedUrls[0];
    const qParam = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    expect(qParam).toBe("after:2024/01/01 before:2024/06/01");
  });

  it("includes only after: when only scopeDate is set", async () => {
    const { fetchLabelMessageIds } = await import("../src/gmail-api.js");
    await fetchLabelMessageIds("INBOX", "2024/01/01");
    expect(capturedUrls.length).toBe(1);
    const url = capturedUrls[0];
    const qParam = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    expect(qParam).toBe("after:2024/01/01");
  });

  it("includes only before: when only beforeDate is set", async () => {
    const { fetchLabelMessageIds } = await import("../src/gmail-api.js");
    await fetchLabelMessageIds("INBOX", undefined, "2024/06/01");
    expect(capturedUrls.length).toBe(1);
    const url = capturedUrls[0];
    const qParam = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    expect(qParam).toBe("before:2024/06/01");
  });

  it("omits q parameter when neither scopeDate nor beforeDate is set", async () => {
    const { fetchLabelMessageIds } = await import("../src/gmail-api.js");
    await fetchLabelMessageIds("INBOX");
    expect(capturedUrls.length).toBe(1);
    const url = capturedUrls[0];
    expect(new URL(url).searchParams.has("q")).toBe(false);
  });
});

