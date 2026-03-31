import { describe, it, expect } from "vitest";
import { buildSearchQuery, parallelMap, formatLabelForQuery, buildBatchRequestBody, parseBatchResponse } from "../src/gmail-api.js";

describe("buildSearchQuery", () => {
  it("returns empty string for all-mail with no filters", () => {
    expect(buildSearchQuery("all", null, null)).toBe("");
  });

  it("adds in:inbox by default", () => {
    expect(buildSearchQuery(undefined, null, null)).toBe("in:inbox");
  });

  it("adds in:location for non-all locations", () => {
    expect(buildSearchQuery("sent", null, null)).toBe("in:sent");
  });

  it("adds label filter with name escaping", () => {
    expect(buildSearchQuery("all", "Work/Projects", null)).toBe('label:"work-projects"');
  });

  it("escapes quotes in label names", () => {
    expect(buildSearchQuery("all", 'My "Label"', null)).toBe('label:"my-label"');
  });

  it("converts spaces to dashes in labels", () => {
    expect(buildSearchQuery("all", "My Label", null)).toBe('label:"my-label"');
  });

  it("adds after:scope when provided", () => {
    expect(buildSearchQuery("inbox", null, "2024/01/01")).toBe("in:inbox after:2024/01/01");
  });

  it("adds before:date when provided", () => {
    expect(buildSearchQuery("inbox", null, null, "2024/06/01")).toBe("in:inbox before:2024/06/01");
  });

  it("combines all parts", () => {
    const result = buildSearchQuery("inbox", "Work", "2024/01/01", "2024/06/01");
    expect(result).toBe('label:"work" in:inbox after:2024/01/01 before:2024/06/01');
  });

  it("omits beforeDate when null", () => {
    const result = buildSearchQuery("inbox", "Work", "2024/01/01", null);
    expect(result).toBe('label:"work" in:inbox after:2024/01/01');
  });

  it("omits scope when null", () => {
    const result = buildSearchQuery("sent", "Reports", null);
    expect(result).toBe('label:"reports" in:sent');
  });
});

describe("parallelMap", () => {
  it("maps items with bounded concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await parallelMap(items, async (x) => x * 2, 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("handles empty array", async () => {
    const results = await parallelMap([], async (x: number) => x, 3);
    expect(results).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await parallelMap(items, async (x) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
      return x;
    }, 2);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("preserves order", async () => {
    const items = [3, 1, 2];
    const results = await parallelMap(items, async (x) => {
      await new Promise((r) => setTimeout(r, x * 10));
      return x * 10;
    }, 3);
    expect(results).toEqual([30, 10, 20]);
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

describe("buildBatchRequestBody", () => {
  it("builds multipart body for single message", () => {
    const body = buildBatchRequestBody(["msg1"], "test_boundary");
    expect(body).toContain("--test_boundary\r\n");
    expect(body).toContain("Content-Type: application/http");
    expect(body).toContain("Content-ID: <msg0>");
    expect(body).toContain("GET /gmail/v1/users/me/messages/msg1?format=minimal&fields=id,internalDate");
    expect(body).toContain("--test_boundary--");
  });

  it("builds multipart body for multiple messages", () => {
    const body = buildBatchRequestBody(["id1", "id2", "id3"], "boundary123");
    expect(body).toContain("Content-ID: <msg0>");
    expect(body).toContain("Content-ID: <msg1>");
    expect(body).toContain("Content-ID: <msg2>");
    expect(body).toContain("/messages/id1?");
    expect(body).toContain("/messages/id2?");
    expect(body).toContain("/messages/id3?");
    expect(body).toContain("--boundary123--");
  });

  it("returns only closing boundary for empty array", () => {
    const body = buildBatchRequestBody([], "b");
    expect(body).toBe("--b--");
  });
});

describe("parseBatchResponse", () => {
  it("parses multipart response with multiple messages", () => {
    const responseText = [
      "--batch_abc",
      "Content-Type: application/http",
      "Content-ID: <response-msg0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      '{"id": "m1", "internalDate": "1700000000000"}',
      "--batch_abc",
      "Content-Type: application/http",
      "Content-ID: <response-msg1>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      '{"id": "m2", "internalDate": "1700100000000"}',
      "--batch_abc--",
    ].join("\r\n");
    const results = parseBatchResponse(responseText, "multipart/mixed; boundary=batch_abc");
    expect(results).toEqual([
      { id: "m1", internalDate: 1700000000000 },
      { id: "m2", internalDate: 1700100000000 },
    ]);
  });

  it("handles missing internalDate gracefully", () => {
    const responseText = [
      "--b",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id": "m1"}',
      "--b--",
    ].join("\r\n");
    const results = parseBatchResponse(responseText, "multipart/mixed; boundary=b");
    expect(results).toEqual([{ id: "m1", internalDate: 0 }]);
  });

  it("skips parts without valid JSON", () => {
    const responseText = [
      "--b",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 404 Not Found",
      "",
      "not json",
      "--b",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id": "m2", "internalDate": "123"}',
      "--b--",
    ].join("\r\n");
    const results = parseBatchResponse(responseText, "multipart/mixed; boundary=b");
    expect(results).toEqual([{ id: "m2", internalDate: 123 }]);
  });

  it("throws when no boundary in content type", () => {
    expect(() => parseBatchResponse("body", "text/plain")).toThrow("No boundary");
  });

  it("returns empty array for empty response", () => {
    const results = parseBatchResponse("--b\r\n--b--", "multipart/mixed; boundary=b");
    expect(results).toEqual([]);
  });
});
