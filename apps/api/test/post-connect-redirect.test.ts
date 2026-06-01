import { describe, expect, it } from "vitest";
import { dashboardConnectRedirect } from "../src/post-connect-redirect.js";

describe("dashboardConnectRedirect", () => {
  it("returns null when no dashboard origin is configured (fall back to /installed)", () => {
    expect(dashboardConnectRedirect(null, "shopify", { shop: "x.myshopify.com" })).toBeNull();
    expect(dashboardConnectRedirect("", "shopify")).toBeNull();
  });

  it("points at the dashboard integrations page with a connected marker + shop", () => {
    const url = dashboardConnectRedirect("https://dash.example.com", "shopify", {
      shop: "acme.myshopify.com",
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("https://dash.example.com");
    expect(parsed.pathname).toBe("/settings/integrations");
    expect(parsed.searchParams.get("connected")).toBe("shopify");
    expect(parsed.searchParams.get("shop")).toBe("acme.myshopify.com");
  });

  it("omits the shop param when there is no shop (e.g. Gmail/Sheets)", () => {
    const url = dashboardConnectRedirect("https://dash.example.com", "gmail");
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("connected")).toBe("gmail");
    expect(parsed.searchParams.has("shop")).toBe(false);
  });

  it("preserves a path prefix on the dashboard base URL", () => {
    const url = dashboardConnectRedirect("https://example.com/app", "shopify", {
      shop: "acme.myshopify.com",
    });
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe("/app/settings/integrations");
  });

  it("returns null on an unparseable base URL instead of throwing", () => {
    expect(dashboardConnectRedirect("not a url", "shopify")).toBeNull();
  });
});
