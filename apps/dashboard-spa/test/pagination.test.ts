import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageOptionsFor,
  parsePageSize,
  resolveDefaultPageSize,
  resolvePageSize,
  totalPagesFor,
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

describe("totalPagesFor", () => {
  it("always returns at least one page", () => {
    expect(totalPagesFor(0, 10)).toBe(1);
  });

  it("rounds up partial pages", () => {
    expect(totalPagesFor(21, 10)).toBe(3);
    expect(totalPagesFor(20, 10)).toBe(2);
  });
});

describe("pageOptionsFor", () => {
  const pages = (page: number, totalPages: number) =>
    pageOptionsFor(page, totalPages).map((o) =>
      o.kind === "page" ? o.value : "…",
    );

  it("lists every page with no ellipsis when nine or fewer", () => {
    expect(pages(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pages(4, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("brackets the current page with ellipses in the middle of a long range", () => {
    expect(pages(10, 20)).toEqual([1, "…", 8, 9, 10, 11, 12, "…", 20]);
  });

  it("omits the leading ellipsis when near the start", () => {
    expect(pages(1, 20)).toEqual([1, 2, 3, "…", 20]);
  });

  it("omits the trailing ellipsis when near the end", () => {
    expect(pages(20, 20)).toEqual([1, "…", 18, 19, 20]);
  });

  it("gives ellipsis options a stable unique id", () => {
    const opts = pageOptionsFor(10, 20).filter((o) => o.kind === "ellipsis");
    const ids = opts.map((o) => (o.kind === "ellipsis" ? o.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
