import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  parsePageSize,
  resolveDefaultPageSize,
  resolvePageSize,
} from "../lib/pagination.js";

describe("DEFAULT_PAGE_SIZE", () => {
  it("defaults tables to 10 rows", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(10);
  });

  it("is a selectable option", () => {
    expect(PAGE_SIZE_OPTIONS).toContain(DEFAULT_PAGE_SIZE);
  });
});

describe("parsePageSize", () => {
  it("accepts a valid option from the URL", () => {
    expect(parsePageSize("50")).toBe(50);
  });

  it("falls back to the default for a missing or bad value", () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("999")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("abc")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("resolveDefaultPageSize", () => {
  it("uses the saved cookie value when it is a valid option", () => {
    expect(resolveDefaultPageSize("25")).toBe(25);
    expect(resolveDefaultPageSize("100")).toBe(100);
  });

  it("falls back to the built-in default for a missing or bad cookie", () => {
    expect(resolveDefaultPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveDefaultPageSize("")).toBe(DEFAULT_PAGE_SIZE);
    expect(resolveDefaultPageSize("999")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("resolvePageSize", () => {
  it("lets an explicit URL limit win over the cookie", () => {
    expect(resolvePageSize("100", "25")).toBe(100);
  });

  it("falls back to the saved cookie default when no URL limit", () => {
    expect(resolvePageSize(undefined, "50")).toBe(50);
  });

  it("falls back to the cookie when the URL limit is invalid", () => {
    expect(resolvePageSize("999", "25")).toBe(25);
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolvePageSize(undefined, undefined)).toBe(DEFAULT_PAGE_SIZE);
  });
});
