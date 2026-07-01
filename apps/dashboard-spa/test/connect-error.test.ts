import { describe, expect, it } from "vitest";

import {
  connectErrorMessage,
  connectedBanner,
  parseConnectError,
  shopifyConnectState,
} from "../lib/connect-error";
import { parseMintDenial } from "../lib/connect-denial";
import type { ShopifyAppGateView } from "@support-agent/dashboard-contracts";

// U6: the api OAuth callback redirects back with `?error=<provider>:<code>`
// when the merchant cancels consent or the token exchange fails. The page
// parses that contract here; anything unparseable renders nothing rather
// than crashing or echoing attacker-controlled text.
describe("parseConnectError", () => {
  it("splits provider and code", () => {
    expect(parseConnectError("gmail:access_denied")).toEqual({
      provider: "gmail",
      code: "access_denied",
    });
  });

  it("keeps extra colons inside the code", () => {
    expect(parseConnectError("outlook:exchange_failed:500")).toEqual({
      provider: "outlook",
      code: "exchange_failed:500",
    });
  });

  it("returns null for the legacy already_connected code (handled separately)", () => {
    expect(parseConnectError("already_connected")).toBeNull();
  });

  it("returns null for missing / colon-less / empty-part values", () => {
    expect(parseConnectError(undefined)).toBeNull();
    expect(parseConnectError("")).toBeNull();
    expect(parseConnectError("gmail:")).toBeNull();
    expect(parseConnectError(":access_denied")).toBeNull();
  });

  it("rejects an unknown provider rather than echoing it", () => {
    expect(parseConnectError("evilco:access_denied")).toBeNull();
  });
});

describe("connectErrorMessage", () => {
  it("explains a consent denial", () => {
    expect(connectErrorMessage("access_denied")).toMatch(/cancel|denied/i);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(connectErrorMessage("some_new_code")).toMatch(/went wrong|fail/i);
  });

  it("explains a refused pilot connect in plain words", () => {
    for (const code of ["not_provisioned", "revoked"]) {
      const msg = connectErrorMessage(code);
      expect(msg).toMatch(/workspace/i);
      expect(msg).toMatch(/set.?ting up|sets up|ready/i);
    }
  });

  it("explains a deployment with no Shopify app at all", () => {
    expect(connectErrorMessage("app_not_configured")).toMatch(/support/i);
  });
});

// The Connect button must be grayed whenever this workspace has no app
// credentials to install with — the api's `available` field mirrors its own
// install gate, and the page only picks the explanation copy.
describe("shopifyConnectState", () => {
  const gate = (over: Partial<ShopifyAppGateView>): ShopifyAppGateView => ({
    requiresProvisioning: false,
    provisioned: false,
    status: null,
    available: true,
    ...over,
  });

  it("available → connect enabled", () => {
    expect(shopifyConnectState(gate({}))).toBe("available");
    expect(
      shopifyConnectState(
        gate({ requiresProvisioning: true, provisioned: true, status: "ready" }),
      ),
    ).toBe("available");
  });

  it("pilot workspace with no provisioned app → awaiting provisioning", () => {
    expect(
      shopifyConnectState(gate({ requiresProvisioning: true, available: false })),
    ).toBe("awaiting_provisioning");
  });

  it("pilot workspace with a revoked app → awaiting provisioning", () => {
    expect(
      shopifyConnectState(
        gate({
          requiresProvisioning: true,
          status: "revoked",
          available: false,
        }),
      ),
    ).toBe("awaiting_provisioning");
  });

  it("no app configured anywhere → unconfigured", () => {
    expect(shopifyConnectState(gate({ available: false }))).toBe("unconfigured");
  });
});

// `?connected=<provider>` is only a redirect breadcrumb — the success banner
// must be backed by an actual active connection in THIS workspace. (A connect
// once completed against a different workspace and still showed "connected.")
describe("connectedBanner", () => {
  it("active row → success banner", () => {
    expect(connectedBanner("shopify", "active")).toEqual({
      kind: "connected",
      label: "Shopify",
    });
  });

  it("no row in this workspace → warning banner, not success", () => {
    expect(connectedBanner("shopify", undefined)).toEqual({
      kind: "not_landed",
      label: "Shopify",
    });
  });

  it("revoked row → warning banner", () => {
    expect(connectedBanner("gmail", "revoked")).toEqual({
      kind: "not_landed",
      label: "Gmail",
    });
  });

  it("absent param or unknown provider → no banner", () => {
    expect(connectedBanner(undefined, undefined)).toBeNull();
    expect(connectedBanner("evilco", "active")).toBeNull();
  });
});

// The grant-mint endpoint now refuses workspaces with no resolvable app.
// Map its refusals onto the `?error=shopify:<code>` banner contract; anything
// unrecognized stays null so the caller falls back to throwing.
describe("parseMintDenial", () => {
  it("maps a pilot provisioning refusal", () => {
    expect(
      parseMintDenial(403, {
        error: "shopify_provisioning_required",
        reason: "not_provisioned",
      }),
    ).toBe("not_provisioned");
    expect(
      parseMintDenial(403, {
        error: "shopify_provisioning_required",
        reason: "revoked",
      }),
    ).toBe("revoked");
  });

  it("maps a missing-app refusal", () => {
    expect(parseMintDenial(500, { error: "shopify_app_not_configured" })).toBe(
      "app_not_configured",
    );
  });

  it("ignores success, conflicts, and unrelated errors", () => {
    expect(parseMintDenial(200, { url: "https://x" })).toBeNull();
    expect(parseMintDenial(409, { error: "already_connected" })).toBeNull();
    expect(parseMintDenial(403, { error: "something_else" })).toBeNull();
    expect(parseMintDenial(500, null)).toBeNull();
  });
});
