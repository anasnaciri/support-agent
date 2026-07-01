import { describe, expect, it } from "vitest";
import {
  classifyOrderRef,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from "../case-details-input.js";

describe("normalizeCustomerEmail", () => {
  it("trims and accepts a well-formed address", () => {
    expect(normalizeCustomerEmail("  Jane@Shopper.com ")).toBe(
      "jane@shopper.com",
    );
  });

  it("rejects malformed or empty values", () => {
    expect(normalizeCustomerEmail("not-an-email")).toBeNull();
    expect(normalizeCustomerEmail("mailer@shopify")).toBeNull();
    expect(normalizeCustomerEmail("   ")).toBeNull();
    expect(normalizeCustomerEmail("")).toBeNull();
    expect(normalizeCustomerEmail(42)).toBeNull();
    expect(normalizeCustomerEmail("a b@x.com")).toBeNull();
  });
});

describe("normalizeCustomerName", () => {
  it("trims a non-empty name", () => {
    expect(normalizeCustomerName("  Jane Shopper ")).toBe("Jane Shopper");
  });

  it("returns null for empty / non-string", () => {
    expect(normalizeCustomerName("   ")).toBeNull();
    expect(normalizeCustomerName("")).toBeNull();
    expect(normalizeCustomerName(null)).toBeNull();
    expect(normalizeCustomerName(undefined)).toBeNull();
  });
});

describe("normalizeCustomerPhone", () => {
  it("trims a non-empty phone (kept permissive on format)", () => {
    expect(normalizeCustomerPhone("  +1 555 123 4567 ")).toBe("+1 555 123 4567");
  });

  it("returns null for empty / non-string", () => {
    expect(normalizeCustomerPhone("   ")).toBeNull();
    expect(normalizeCustomerPhone("")).toBeNull();
    expect(normalizeCustomerPhone(null)).toBeNull();
    expect(normalizeCustomerPhone(undefined)).toBeNull();
  });
});

describe("classifyOrderRef", () => {
  it("recognizes a Shopify order GID", () => {
    expect(classifyOrderRef("gid://shopify/Order/12345")).toBe("gid");
  });

  it("recognizes an order name (#1001 or 1001)", () => {
    expect(classifyOrderRef("#1001")).toBe("name");
    expect(classifyOrderRef("1001")).toBe("name");
  });

  it("treats an alphanumeric code as a confirmation number", () => {
    expect(classifyOrderRef("XPAV284CT")).toBe("confirmation");
  });
});
