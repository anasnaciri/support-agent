import { describe, expect, it, vi } from "vitest";
import {
  revokeConnectorGrant,
  revokeGoogleOAuthToken,
  uninstallShopifyApp,
} from "../src/oauth-revocation.js";

const ok = (status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    json: async () => ({}),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
    headers: new Headers(),
  }) as unknown as Response;

describe("revokeGoogleOAuthToken", () => {
  it("POSTs the token to Google's revoke endpoint as form-urlencoded", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await revokeGoogleOAuthToken("rt_123", fetchImpl);
    expect(outcome.kind).toBe("revoked");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://oauth2.googleapis.com/revoke");
    expect(init!.method).toBe("POST");
    expect(
      (init!.headers as Record<string, string>)["Content-Type"],
    ).toContain("application/x-www-form-urlencoded");
    expect(String(init!.body)).toBe("token=rt_123");
  });

  it("treats Google's 400 (token already invalid) as already_gone", async () => {
    const fetchImpl = vi.fn(async () => fail(400, "invalid_token"));
    const outcome = await revokeGoogleOAuthToken("dead", fetchImpl);
    expect(outcome.kind).toBe("already_gone");
  });

  it("returns failed on a 5xx", async () => {
    const fetchImpl = vi.fn(async () => fail(503));
    const outcome = await revokeGoogleOAuthToken("rt", fetchImpl);
    expect(outcome.kind).toBe("failed");
  });

  it("returns failed (never throws) when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const outcome = await revokeGoogleOAuthToken("rt", fetchImpl);
    expect(outcome.kind).toBe("failed");
  });
});

describe("uninstallShopifyApp", () => {
  it("DELETEs api_permissions/current.json with the access token header", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await uninstallShopifyApp(
      {
        shopDomain: "pilot.myshopify.com",
        accessToken: "shpat_abc",
        apiVersion: "2025-01",
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("revoked");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://pilot.myshopify.com/admin/api/2025-01/api_permissions/current.json",
    );
    expect(init!.method).toBe("DELETE");
    expect(
      (init!.headers as Record<string, string>)["X-Shopify-Access-Token"],
    ).toBe("shpat_abc");
  });

  it("treats a 401 (token already invalid) as already_gone", async () => {
    const fetchImpl = vi.fn(async () => fail(401));
    const outcome = await uninstallShopifyApp(
      { shopDomain: "x.myshopify.com", accessToken: "dead", apiVersion: null },
      fetchImpl,
    );
    expect(outcome.kind).toBe("already_gone");
  });
});

describe("revokeConnectorGrant — dispatch", () => {
  it("uninstalls for a shopify grant", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await revokeConnectorGrant(
      {
        provider: "shopify",
        shopDomain: "s.myshopify.com",
        accessToken: "shpat",
        refreshToken: null,
        apiVersion: "2025-01",
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("revoked");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("api_permissions");
  });

  it("stops the Gmail watch then revokes the refresh token for a gmail grant", async () => {
    const calls: Array<string> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return ok();
    });
    const outcome = await revokeConnectorGrant(
      {
        provider: "gmail",
        shopDomain: "ops@store.com",
        accessToken: "ya29_access",
        refreshToken: "1//refresh",
        apiVersion: null,
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("revoked");
    // watch stop first, then token revoke (prefers the refresh token).
    expect(calls[0]).toContain("/users/me/stop");
    expect(calls[1]).toBe("https://oauth2.googleapis.com/revoke");
  });

  it("revokes the token for a google_sheets grant (no watch to stop)", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await revokeConnectorGrant(
      {
        provider: "google_sheets",
        shopDomain: "sheets",
        accessToken: "ya29",
        refreshToken: null,
        apiVersion: null,
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("revoked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
  });

  it("no-ops for an outlook grant (no client-callable revoke; sub self-expires)", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await revokeConnectorGrant(
      {
        provider: "outlook",
        shopDomain: "ops@store.com",
        accessToken: "graph_access",
        refreshToken: "graph_refresh",
        apiVersion: null,
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("already_gone");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no-ops for an imap grant (no provider-side grant to revoke)", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const outcome = await revokeConnectorGrant(
      {
        provider: "imap",
        shopDomain: "support@store.com",
        accessToken: "app-password",
        refreshToken: null,
        apiVersion: null,
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe("already_gone");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
