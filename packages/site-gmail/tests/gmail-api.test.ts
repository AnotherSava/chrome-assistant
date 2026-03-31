import { describe, it, expect } from "vitest";
import { buildSearchQuery, parallelMap } from "../src/gmail-api.js";

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
