import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import type { ConnectorConnection } from "@support-agent/services";
import {
  activeMailboxConflict,
  alreadyConnectedRedirect,
} from "../src/connect-guard.js";

const tenantId = TenantId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

const conn = (
  over: Partial<ConnectorConnection> & {
    readonly provider: ConnectorConnection["provider"];
    readonly shopDomain: string;
  },
): ConnectorConnection => ({
  tenantId,
  accessToken: "tok",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata: {},
  scopes: [],
  apiVersion: null,
  installedAt: new Date(0),
  status: "active",
  ...over,
});

describe("activeMailboxConflict", () => {
  it("flags an active row for the provider when no mailbox is known yet (pre-OAuth)", () => {
    const hit = activeMailboxConflict(
      [conn({ provider: "outlook", shopDomain: "a@x.com" })],
      "outlook",
    );
    expect(hit?.shopDomain).toBe("a@x.com");
  });

  it("ignores revoked rows and other providers", () => {
    const hit = activeMailboxConflict(
      [
        conn({ provider: "outlook", shopDomain: "a@x.com", status: "revoked" }),
        conn({ provider: "gmail", shopDomain: "b@x.com" }),
        conn({ provider: "shopify", shopDomain: "shop.myshopify.com" }),
      ],
      "outlook",
    );
    expect(hit).toBeNull();
  });

  it("allows re-connecting the SAME mailbox (case-insensitive)", () => {
    const rows = [conn({ provider: "gmail", shopDomain: "Support@x.com" })];
    expect(activeMailboxConflict(rows, "gmail", "support@x.com")).toBeNull();
  });

  it("flags a DIFFERENT mailbox on the same provider", () => {
    const rows = [conn({ provider: "gmail", shopDomain: "a@x.com" })];
    const hit = activeMailboxConflict(rows, "gmail", "b@x.com");
    expect(hit?.shopDomain).toBe("a@x.com");
  });
});

describe("alreadyConnectedRedirect", () => {
  it("builds the integrations-page error URL", () => {
    const url = alreadyConnectedRedirect(
      "https://dash.example.com",
      "outlook",
      "a@x.com",
    );
    expect(url).toBe(
      "https://dash.example.com/settings/integrations?error=already_connected&provider=outlook&mailbox=a%40x.com",
    );
  });

  it("preserves a base-URL path prefix and trims trailing slashes", () => {
    const url = alreadyConnectedRedirect(
      "https://example.com/app/",
      "gmail",
      "a@x.com",
    );
    expect(url).toBe(
      "https://example.com/app/settings/integrations?error=already_connected&provider=gmail&mailbox=a%40x.com",
    );
  });

  it("returns null without a dashboard base URL", () => {
    expect(alreadyConnectedRedirect(null, "gmail", "a@x.com")).toBeNull();
    expect(alreadyConnectedRedirect("  ", "gmail", "a@x.com")).toBeNull();
  });
});
