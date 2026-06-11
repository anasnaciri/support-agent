import { describe, expect, it } from "vitest";
import {
  dashboardConnectErrorRedirect,
  dashboardConnectRedirect,
} from "../src/post-connect-redirect.js";

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

// Audit U6 — a merchant who cancels the provider consent screen (or whose
// callback fails) previously got a raw JSON error in the browser. The
// dashboard renders ?error=<provider>:<code> as a warning Alert.
describe("dashboardConnectErrorRedirect", () => {
  it("builds the ?error=<provider>:<code> contract", () => {
    const url = dashboardConnectErrorRedirect(
      "https://dash.example.com",
      "gmail",
      "access_denied",
    );
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe("/settings/integrations");
    expect(parsed.searchParams.get("error")).toBe("gmail:access_denied");
  });

  it("returns null without a dashboard base URL (caller keeps the JSON fallback)", () => {
    expect(
      dashboardConnectErrorRedirect(null, "outlook", "exchange_failed"),
    ).toBeNull();
  });
});
