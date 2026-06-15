import { describe, expect, it } from "vitest";
import type { UnsentSupplierEscalation } from "@support-agent/db";
import type { SendSupplierEscalationInput } from "@support-agent/services";
import {
  fireSupplierNotificationsOnce,
  type SendOutcome,
  type SupplierNotifyDeps,
} from "../src/supplier-notify-schedule.js";

const esc = (
  id: string,
  over: Partial<UnsentSupplierEscalation> = {},
): UnsentSupplierEscalation => ({
  id,
  tenantId: "t1",
  supplierEmail: "wh@x.com",
  problem: "P",
  orderRef: "#1",
  ...over,
});

describe("fireSupplierNotificationsOnce — durable outbox sweep", () => {
  it("sends each unsent escalation, stamps successes, bumps attempts on failure", async () => {
    const marked: string[] = [];
    const failures: Array<[string, string]> = [];
    const sentInputs: SendSupplierEscalationInput[] = [];
    const deps: SupplierNotifyDeps = {
      portalBaseUrl: "https://app.example.com",
      listUnsent: async () => [esc("e1"), esc("e2")],
      send: async (input) => {
        sentInputs.push(input);
        return input.escalationId === "e2"
          ? ({ error: "smtp down" } as SendOutcome)
          : "sent";
      },
      markNotified: async (id) => {
        marked.push(id);
      },
      recordFailure: async (id, e) => {
        failures.push([id, e]);
      },
    };
    const res = await fireSupplierNotificationsOnce(deps);
    expect(res).toEqual({ sent: 1, failed: 1 });
    expect(marked).toEqual(["e1"]); // only the success is stamped notified
    expect(failures).toEqual([["e2", "smtp down"]]); // the failure is retried later
    // Portal deep link is built per-escalation; the PII-free projection forwarded.
    expect(sentInputs[0]!.portalUrl).toBe(
      "https://app.example.com/supplier/cases/e1",
    );
    expect(sentInputs[0]).toMatchObject({
      tenantId: "t1",
      supplierEmail: "wh@x.com",
      problem: "P",
      orderRef: "#1",
    });
  });

  it("omits the portal link when no base URL is configured", async () => {
    let captured: SendSupplierEscalationInput | undefined;
    await fireSupplierNotificationsOnce({
      portalBaseUrl: null,
      listUnsent: async () => [esc("e9")],
      send: async (input) => {
        captured = input;
        return "sent";
      },
      markNotified: async () => {},
      recordFailure: async () => {},
    });
    expect(captured?.portalUrl).toBeNull();
  });

  it("does nothing when there's nothing to send", async () => {
    const res = await fireSupplierNotificationsOnce({
      portalBaseUrl: null,
      listUnsent: async () => [],
      send: async () => "sent",
      markNotified: async () => {},
      recordFailure: async () => {},
    });
    expect(res).toEqual({ sent: 0, failed: 0 });
  });
});
