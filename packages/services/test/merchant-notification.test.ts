import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId, CaseId } from "@support-agent/agent-core";
import {
  MerchantNotificationService,
  MerchantNotificationSendFailed,
  makeMerchantNotificationServiceTest,
  type MerchantNotification,
} from "../src/index.js";

const t1 = TenantId("t1");

const note: MerchantNotification = {
  kind: "agent_note",
  title: "Agent needs a sanity check",
  body: "Customer claims a promo code that isn't in the knowledge base.",
  caseId: CaseId("c1"),
};

describe("MerchantNotificationService test layer", () => {
  it("records every notify call and reports telegram delivery", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(result).toEqual({ delivered: true, channel: "telegram" });
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]?.tenantId).toBe(t1);
    expect(handle.sent[0]?.notification.kind).toBe("agent_note");
    expect(handle.sent[0]?.notification.title).toContain("sanity check");
  });

  it("reports delivered:false for tenants without a connected channel", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest({
      disconnectedFor: new Set([t1]),
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(result).toEqual({ delivered: false, channel: null });
    // The attempt is still recorded so tests can assert the caller tried.
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]?.result.delivered).toBe(false);
  });

  it("fails with MerchantNotificationSendFailed when failAll is set", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest({
      failAll: true,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, note);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = exit.cause;
      expect(JSON.stringify(failure)).toContain(
        "MerchantNotificationSendFailed",
      );
    }
    expect(handle.sent).toHaveLength(0);
  });

  it("accepts notifications without a caseId (account-level alerts)", async () => {
    const { layer, handle } = makeMerchantNotificationServiceTest();
    const accountAlert: MerchantNotification = {
      kind: "llm_credits_low",
      title: "OpenRouter credits running low",
      body: "Remaining balance is $3.20 — top up to keep the agent running.",
    };
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* MerchantNotificationService;
          return yield* svc.notify(t1, accountAlert);
        }),
        layer,
      ),
    );
    expect(result.delivered).toBe(true);
    expect(handle.sent[0]?.notification.caseId).toBeUndefined();
  });
});

describe("MerchantNotificationSendFailed", () => {
  it("is a tagged error carrying the tenant", () => {
    const err = new MerchantNotificationSendFailed({
      tenantId: t1,
      cause: "boom",
    });
    expect(err._tag).toBe("MerchantNotificationSendFailed");
    expect(err.tenantId).toBe(t1);
  });
});
