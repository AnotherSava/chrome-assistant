import { describe, it, expect } from "vitest";
import { extractMaxDiscount } from "../src/discount.js";

describe("extractMaxDiscount", () => {
  it("returns null for empty input", () => {
    expect(extractMaxDiscount("")).toBeNull();
  });

  it("returns null when phrase is absent", () => {
    expect(extractMaxDiscount("Save up to $50 on your next order!")).toBeNull();
  });

  it("extracts 'Maximum discount is $20'", () => {
    expect(extractMaxDiscount("Maximum discount is $20")).toBe(20);
  });

  it("extracts 'maximum discount $10' (no 'is')", () => {
    expect(extractMaxDiscount("maximum discount $10")).toBe(10);
  });

  it("extracts 'Maximum discount: $50'", () => {
    expect(extractMaxDiscount("Maximum discount: $50")).toBe(50);
  });

  it("extracts 'Maximum discount of $100'", () => {
    expect(extractMaxDiscount("Maximum discount of $100")).toBe(100);
  });

  it("supports 'Max discount $25'", () => {
    expect(extractMaxDiscount("Max discount $25")).toBe(25);
  });

  it("handles decimal cents '$19.99'", () => {
    expect(extractMaxDiscount("Maximum discount is $19.99")).toBe(19.99);
  });

  it("handles thousand separator '$1,000'", () => {
    expect(extractMaxDiscount("Maximum discount is $1,000")).toBe(1000);
  });

  it("picks the highest when multiple phrases are present", () => {
    expect(extractMaxDiscount("Maximum discount $10 today. Maximum discount $50 for new customers.")).toBe(50);
  });

  it("is case-insensitive", () => {
    expect(extractMaxDiscount("MAXIMUM DISCOUNT IS $30")).toBe(30);
  });

  it("ignores nearby unrelated dollar amounts", () => {
    expect(extractMaxDiscount("Buy a $200 jacket. Maximum discount is $20.")).toBe(20);
  });
});
