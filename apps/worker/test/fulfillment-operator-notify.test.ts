import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId, TenantId } from "@support-agent/agent-core";
import type { UnsentFulfillmentOperatorEscalation } from "@support-agent/db";
import {
  ApprovalServiceTest,
  AuditLogService,
  AuditLogServiceTest,
  TicketLifecycleWriterLive,
  TicketRepository,
  TicketRepositoryTest,
  TransactionRunnerPassthrough,
  type SendFulfillmentOperatorEscalationInput,
} from "@support-agent/services";
import {
  FULFILLMENT_OPERATOR_UNREACHABLE_FLAG,
  escalateFulfillmentOperatorNotifyFailure,
  fireFulfillmentOperatorNotificationsOnce,
  type SendOutcome,
  type FulfillmentOperatorNotifyDeps,
} from "../src/fulfillment-operator-notify-schedule.js";

const esc = (
  id: string,
  over: Partial<UnsentFulfillmentOperatorEscalation> = {},
): UnsentFulfillmentOperatorEscalation => ({
  id,
  ticketId: "ticket-1",
  tenantId: "t1",
  fulfillmentOperatorEmail: "wh@x.com",
  problem: "P",
  orderRef: "#1",
  notifyAttempts: 0,
  ...over,
});

describe("fireFulfillmentOperatorNotificationsOnce — durable outbox sweep", () => {
  it("sends each unsent escalation, stamps successes, bumps attempts on failure", async () => {
    const marked: string[] = [];
    const failures: Array<[string, string]> = [];
    const sentInputs: SendFulfillmentOperatorEscalationInput[] = [];
    const deps: FulfillmentOperatorNotifyDeps = {
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
      abandonFailure: async () => {},
      maxAttempts: 6,
    };
    const res = await fireFulfillmentOperatorNotificationsOnce(deps);
    expect(res).toEqual({ sent: 1, failed: 1, abandoned: 0 });
    expect(marked).toEqual(["e1"]); // only the success is stamped notified
    expect(failures).toEqual([["e2", "smtp down"]]); // the failure is retried later
    // Portal deep link is built per-escalation; the PII-free projection forwarded.
    // ?w pins the workspace so a fulfillmentOperator serving several merchants lands on the
    // right one (their active workspace may be a different merchant).
    expect(sentInputs[0]!.portalUrl).toBe(
      "https://app.example.com/fulfillment-operator/tickets/e1?w=t1",
    );
    expect(sentInputs[0]).toMatchObject({
      tenantId: "t1",
      fulfillmentOperatorEmail: "wh@x.com",
      problem: "P",
      orderRef: "#1",
    });
  });

  it("omits the portal link when no base URL is configured", async () => {
    let captured: SendFulfillmentOperatorEscalationInput | undefined;
    await fireFulfillmentOperatorNotificationsOnce({
      portalBaseUrl: null,
      listUnsent: async () => [esc("e9")],
      send: async (input) => {
        captured = input;
        return "sent";
      },
      markNotified: async () => {},
      recordFailure: async () => {},
      abandonFailure: async () => {},
      maxAttempts: 6,
    });
    expect(captured?.portalUrl).toBeNull();
  });

  it("does nothing when there's nothing to send", async () => {
    const res = await fireFulfillmentOperatorNotificationsOnce({
      portalBaseUrl: null,
      listUnsent: async () => [],
      send: async () => "sent",
      markNotified: async () => {},
      recordFailure: async () => {},
      abandonFailure: async () => {},
      maxAttempts: 6,
    });
    expect(res).toEqual({ sent: 0, failed: 0, abandoned: 0 });
  });

  it("abandons instead of retrying when the final notification attempt fails", async () => {
    const failures: Array<[string, string]> = [];
    const abandoned: Array<[string, string]> = [];
    const res = await fireFulfillmentOperatorNotificationsOnce({
      portalBaseUrl: null,
      listUnsent: async () => [esc("e-cap", { notifyAttempts: 5 })],
      send: async () => ({ error: "hard bounce" }) as SendOutcome,
      markNotified: async () => {},
      recordFailure: async (id, error) => {
        failures.push([id, error]);
      },
      abandonFailure: async (escalation, error) => {
        abandoned.push([escalation.id, error]);
      },
      maxAttempts: 6,
    });

    expect(res).toEqual({ sent: 0, failed: 1, abandoned: 1 });
    expect(failures).toEqual([]);
    expect(abandoned).toEqual([["e-cap", "hard bounce"]]);
  });

  it("parks and flags the merchant ticket when fulfillmentOperator notification is abandoned", async () => {
    const deps = Layer.mergeAll(
      ApprovalServiceTest,
      TicketRepositoryTest,
      AuditLogServiceTest,
      TransactionRunnerPassthrough,
    );
    const layer = Layer.provideMerge(TicketLifecycleWriterLive, deps);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TicketRepository;
          const audit = yield* AuditLogService;
          const row = yield* repo.create({
            tenantId: TenantId("t1"),
            channel: "email",
            currentAgentId: AgentId("missing-package-agent"),
            status: "waiting_for_fulfillment_operator",
            subject: "Missing order",
          });
          yield* escalateFulfillmentOperatorNotifyFailure({
            escalation: esc("e-cap", { ticketId: row.id }),
            error: "hard bounce",
          });
          const fetched = yield* repo.getById(row.id);
          const entries = yield* audit.forTicket(row.id);
          return { fetched, entries };
        }),
        layer,
      ),
    );

    expect(out.fetched.status).toBe("human_takeover");
    expect(out.fetched.context["riskFlags"]).toContain(
      FULFILLMENT_OPERATOR_UNREACHABLE_FLAG,
    );
    const escalation = out.entries.find(
      (entry) => entry.action === "ticket.escalated_to_human",
    );
    expect(escalation?.details["reason"]).toBe(FULFILLMENT_OPERATOR_UNREACHABLE_FLAG);
    expect(escalation?.details["escalationId"]).toBe("e-cap");
  });
});
