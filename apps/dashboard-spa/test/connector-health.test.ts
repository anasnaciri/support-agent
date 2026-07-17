import { describe, expect, it } from "vitest";

import {
  connectorHealth,
  connectorHealthRefetchInterval,
  connectorHealthReasonLabel,
} from "../lib/connector-health";

// The worker's renewal/poll crons stamp health into a connection's jsonb
// metadata (`connectorHealth` / `connectorHealthReason` / `connectorHealthAt`,
// see apps/worker/src/connector-health.ts). The dashboard only reads it. This
// helper must read an `unknown` metadata blob safely (it comes off the wire as
// `unknown` in the contract) and humanize the raw failure reason — no raw codes
// or jargon may reach the rendered badge.

describe("connectorHealth", () => {
  it("reads a broken flag with its reason and timestamp", () => {
    const result = connectorHealth({
      connectorHealth: "broken",
      connectorHealthReason: "no refresh token stored — reconnect the mailbox",
      connectorHealthAt: "2026-06-13T10:00:00.000Z",
    });
    expect(result.state).toBe("broken");
    expect(result.reason).toBe(
      "no refresh token stored — reconnect the mailbox",
    );
    expect(result.at).toBe("2026-06-13T10:00:00.000Z");
  });

  it("reports ok when the flag says ok", () => {
    expect(connectorHealth({ connectorHealth: "ok" }).state).toBe("ok");
    expect(connectorHealth({ connectorHealth: "ok" }).reason).toBeNull();
  });

  it("defaults to ok when the flag is absent (legacy rows)", () => {
    expect(connectorHealth({ baseURL: "https://x" }).state).toBe("ok");
  });

  it("defaults to ok on malformed / non-object metadata", () => {
    expect(connectorHealth(null).state).toBe("ok");
    expect(connectorHealth(undefined).state).toBe("ok");
    expect(connectorHealth("broken").state).toBe("ok");
    expect(connectorHealth(42).state).toBe("ok");
    expect(connectorHealth([]).state).toBe("ok");
  });

  it("treats any non-'broken' flag value as ok", () => {
    expect(connectorHealth({ connectorHealth: "weird" }).state).toBe("ok");
    expect(connectorHealth({ connectorHealth: 1 }).state).toBe("ok");
  });

  it("nulls a non-string reason or timestamp instead of leaking it", () => {
    const result = connectorHealth({
      connectorHealth: "broken",
      connectorHealthReason: { nested: true },
      connectorHealthAt: 123,
    });
    expect(result.state).toBe("broken");
    expect(result.reason).toBeNull();
    expect(result.at).toBeNull();
  });
});

describe("connectorHealthReasonLabel", () => {
  it("maps a missing refresh token to plain reconnect copy", () => {
    expect(
      connectorHealthReasonLabel(
        "no refresh token stored — reconnect the mailbox",
      ),
    ).toBe("The connection was signed out. Reconnect to restore access.");
  });

  it("maps a revoked / invalid_grant token-refresh failure to plain copy", () => {
    const copy = connectorHealthReasonLabel(
      "gmail token refresh failed: 400 invalid_grant",
    );
    expect(copy).toBe(
      "The connection was signed out. Reconnect to restore access.",
    );
  });

  it("maps an expired / unauthorized auth failure to plain copy", () => {
    expect(
      connectorHealthReasonLabel("graph token refresh failed: 401 unauthorized"),
    ).toBe(
      "Access was no longer accepted. Reconnect to grant access again.",
    );
  });

  it("maps a lapsed Microsoft subscription to plain copy", () => {
    expect(
      connectorHealthReasonLabel(
        "subscription: The subscription has expired or was deleted",
      ),
    ).toBe(
      "The mailbox stopped delivering new messages. Reconnect to resume.",
    );
  });

  it("collapses an unknown raw reason to a generic reconnect prompt", () => {
    const copy = connectorHealthReasonLabel("ECONNRESET socket hang up");
    expect(copy).toBe("This connection needs reconnecting.");
    expect(copy).not.toMatch(/ECONNRESET/);
  });

  it("never leaks a raw code, colon-delimited reason, or status number", () => {
    const raws = [
      "gmail token refresh failed: 400 invalid_grant",
      "graph token refresh failed: 401 unauthorized",
      "subscription: The subscription has expired or was deleted",
      "refresh: invalid_grant",
      "ECONNRESET socket hang up",
      "no refresh token stored — reconnect the mailbox",
    ];
    for (const raw of raws) {
      const copy = connectorHealthReasonLabel(raw);
      expect(copy, raw).not.toMatch(/[:_]/);
      expect(copy, raw).not.toMatch(/\b(40\d|50\d)\b/);
      expect(copy, raw).not.toMatch(/token refresh|invalid_grant|ECONNRESET/i);
    }
  });

  it("falls back to the generic prompt for a null / empty reason", () => {
    expect(connectorHealthReasonLabel(null)).toBe(
      "This connection needs reconnecting.",
    );
    expect(connectorHealthReasonLabel("")).toBe(
      "This connection needs reconnecting.",
    );
  });
});

describe("connectorHealthRefetchInterval", () => {
  it("keeps an open integrations page synchronized without rapid polling", () => {
    expect(connectorHealthRefetchInterval()).toBe(30_000);
  });
});
