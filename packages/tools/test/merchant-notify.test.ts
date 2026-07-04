import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TicketId,
  TenantId,
  type ToolContext,
} from "@support-agent/agent-core";
import { makeMerchantNotificationServiceTest } from "@support-agent/services";
import { ALL_TOOLS, merchantNotify } from "../src/index.js";

const ctx: ToolContext = {
  tenantId: TenantId("t1"),
  ticketId: TicketId("c1"),
  agentId: AgentId("refund-review-agent"),
  callId: "call_1",
  attemptNumber: 1,
};

const input = {
  title: "Unverifiable promo code",
  message:
    "Customer claims promo SAVE50 from a newsletter; the knowledge base has no such code. Proceeding without applying it.",
};

describe("merchant.notify tool", () => {
  it("pushes an agent_note carrying the ticket id and reports delivery", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest();
    const out = await Effect.runPromise(
      Effect.provide(merchantNotify.execute(input, ctx), layer),
    );
    expect(out).toEqual({ delivered: true });
    expect(handle.sent).toHaveLength(1);
    const sent = handle.sent[0]!;
    expect(sent.tenantId).toBe(ctx.tenantId);
    expect(sent.notification.kind).toBe("agent_note");
    expect(sent.notification.title).toBe(input.title);
    expect(sent.notification.body).toBe(input.message);
    expect(sent.notification.ticketId).toBe(ctx.ticketId);
  });

  it("returns delivered:false when the merchant has no channel connected", async () => {
    const { layer } = makeMerchantNotificationServiceTest({
      disconnectedFor: new Set([ctx.tenantId]),
    });
    const out = await Effect.runPromise(
      Effect.provide(merchantNotify.execute(input, ctx), layer),
    );
    expect(out).toEqual({ delivered: false });
  });

  it("maps a transport failure into a ToolError (NetworkError)", async () => {
    const { layer } = makeMerchantNotificationServiceTest({ failAll: true });
    const exit = await Effect.runPromiseExit(
      Effect.provide(merchantNotify.execute(input, ctx), layer),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("NetworkError");
  });

  it("is internal: auto-allowed, no tenant control, communicate risk", () => {
    expect(merchantNotify.defaultPermission).toBe("allow");
    expect(merchantNotify.tenantControl).toBeUndefined();
    expect(merchantNotify.risk).toBe("communicate");
    expect(merchantNotify.sideEffectClass).toBe("external_message");
  });

  it("ships with a JSON-Schema-able input definition", () => {
    const decoded = Schema.decodeUnknownSync(merchantNotify.inputSchema)(input);
    expect(decoded.title).toBe(input.title);
    expect(decoded.message).toBe(input.message);
  });

  it("is registered in ALL_TOOLS", () => {
    expect(ALL_TOOLS.some((t) => t.name === "merchant.notify")).toBe(true);
  });
});
