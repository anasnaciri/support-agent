import { describe, expect, it } from "vitest";
import {
  isNonEmptyString,
  looksLikeGid,
  looksLikeOrderName,
} from "../src/dashboard-shopify.js";

describe("dashboard-shopify id heuristics", () => {
  it("isNonEmptyString", () => {
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
  });

  it("looksLikeOrderName matches #1001 / 1001, not gids", () => {
    expect(looksLikeOrderName("#1001")).toBe(true);
    expect(looksLikeOrderName("1001")).toBe(true);
    expect(looksLikeOrderName("gid://shopify/Order/9")).toBe(false);
    expect(looksLikeOrderName("abc")).toBe(false);
  });

  it("looksLikeGid matches Order/Customer gids only", () => {
    expect(looksLikeGid("gid://shopify/Order/9")).toBe(true);
    expect(looksLikeGid("gid://shopify/Customer/9")).toBe(true);
    expect(looksLikeGid("#1001")).toBe(false);
    expect(looksLikeGid("gid://shopify/Product/9")).toBe(false);
  });
});
