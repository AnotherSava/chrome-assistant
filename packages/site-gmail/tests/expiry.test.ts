import { describe, it, expect } from "vitest";
import { extractExpiryDate } from "../src/expiry.js";

const NOW = new Date(2026, 4, 14);

function ymd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("extractExpiryDate", () => {
  it("returns null for empty input", () => {
    expect(extractExpiryDate("", NOW)).toBeNull();
  });

  it("returns null when no expiry phrase is present", () => {
    expect(extractExpiryDate("Big sale this week, don't miss out!", NOW)).toBeNull();
  });

  it("date-only 'Expires Oct 15' → that day", () => {
    expect(ymd(extractExpiryDate("Big sale! Expires Oct 15", NOW)!)).toBe("2026-10-15");
  });

  it("date-only 'expires October 15, 2027' → that day", () => {
    expect(ymd(extractExpiryDate("expires October 15, 2027", NOW)!)).toBe("2027-10-15");
  });

  it("date-only 'Valid through June 30' → that day", () => {
    expect(ymd(extractExpiryDate("Valid through June 30", NOW)!)).toBe("2026-06-30");
  });

  it("date-only 'Valid until July 4, 2026' → that day", () => {
    expect(ymd(extractExpiryDate("Valid until July 4, 2026", NOW)!)).toBe("2026-07-04");
  });

  it("date-only 'Expires: 12/31/2026' → that day", () => {
    expect(ymd(extractExpiryDate("Expires: 12/31/2026", NOW)!)).toBe("2026-12-31");
  });

  it("date-only 'expires on Oct 15' → that day", () => {
    expect(ymd(extractExpiryDate("Hurry, expires on Oct 15", NOW)!)).toBe("2026-10-15");
  });

  it("ISO 'expires 2027-01-15' → that day", () => {
    expect(ymd(extractExpiryDate("Offer expires 2027-01-15", NOW)!)).toBe("2027-01-15");
  });

  it("12:00 AM = start of day → last valid day is previous day", () => {
    expect(ymd(extractExpiryDate("Expires May 13, 2026 12:00AM", NOW)!)).toBe("2026-05-12");
  });

  it("real-world: '30% off expires May 13, 2026 12:00AM' → May 12", () => {
    expect(ymd(extractExpiryDate("30% off expires May 13, 2026 12:00AM", NOW)!)).toBe("2026-05-12");
  });

  it("11:59 PM = end of day → last valid day is that day", () => {
    expect(ymd(extractExpiryDate("Expires 04/04/26, 11:59pm PT", NOW)!)).toBe("2026-04-04");
  });

  it("rolls forward when undated month is in the past", () => {
    expect(ymd(extractExpiryDate("Expires Jan 15", NOW)!)).toBe("2027-01-15");
  });

  it("keeps current year when undated month is recent", () => {
    expect(ymd(extractExpiryDate("Expires April 1", NOW)!)).toBe("2026-04-01");
  });

  it("handles 'valid until 30 June'", () => {
    expect(ymd(extractExpiryDate("valid until 30 June", NOW)!)).toBe("2026-06-30");
  });

  it("handles ordinal suffix: 'Expires 15th October'", () => {
    expect(ymd(extractExpiryDate("Expires 15th October", NOW)!)).toBe("2026-10-15");
  });

  it("is case-insensitive on prefix", () => {
    expect(ymd(extractExpiryDate("VALID UNTIL July 4", NOW)!)).toBe("2026-07-04");
  });

  it("two-digit year is interpreted as 20xx", () => {
    expect(ymd(extractExpiryDate("expires 06/15/27", NOW)!)).toBe("2027-06-15");
  });

  it("picks the soonest future expiry when multiple are present", () => {
    const text = "Subscription terms expire 1/1/27. Sale expires May 13, 2026.";
    expect(ymd(extractExpiryDate(text, NOW)!)).toBe("2026-05-13");
  });
});
