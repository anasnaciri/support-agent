import { describe, expect, it } from "vitest";
import {
  connectorHealthOf,
  decideHealthTransition,
} from "../src/connector-health.js";

// Audit L5 — a dead connector (revoked refresh token, lapsed Graph
// subscription) previously only console.warn'd: inbound customer mail
// stopped with no alert and no dashboard signal. The health flag lives
// in connector metadata; the alert fires exactly once per ok→broken
// transition.

const at = new Date("2026-06-11T12:00:00.000Z");

describe("connectorHealthOf", () => {
  it("reads broken from metadata, defaulting to ok", () => {
    expect(connectorHealthOf({})).toBe("ok");
    expect(connectorHealthOf({ connectorHealth: "ok" })).toBe("ok");
    expect(connectorHealthOf({ connectorHealth: "broken" })).toBe("broken");
  });
});

describe("decideHealthTransition", () => {
  it("ok → broken patches the flag AND alerts", () => {
    const d = decideHealthTransition("ok", "broken", "refresh token revoked", at);
    expect(d.alert).toBe(true);
    expect(d.patch).toEqual({
      connectorHealth: "broken",
      connectorHealthReason: "refresh token revoked",
      connectorHealthAt: at.toISOString(),
    });
  });

  it("broken → broken does nothing (no re-alert every cron pass)", () => {
    const d = decideHealthTransition("broken", "broken", "still broken", at);
    expect(d.alert).toBe(false);
    expect(d.patch).toBeNull();
  });

  it("broken → ok clears the flag without alerting", () => {
    const d = decideHealthTransition("broken", "ok", null, at);
    expect(d.alert).toBe(false);
    expect(d.patch).toEqual({
      connectorHealth: "ok",
      connectorHealthReason: null,
      connectorHealthAt: at.toISOString(),
    });
  });

  it("ok → ok does nothing", () => {
    const d = decideHealthTransition("ok", "ok", null, at);
    expect(d.alert).toBe(false);
    expect(d.patch).toBeNull();
  });
});
