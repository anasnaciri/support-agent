import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CaseId, TenantId } from "@support-agent/agent-core";
import {
  MerchantNotificationService,
  makePlatformMailServiceTest,
  type MerchantNotification,
} from "@support-agent/services";
import { MerchantNotificationLive } from "../src/telegram-notification-live.js";

// The multi-channel notifier (slice 2). These cover the NEW email channel +
// the OR composition + best-effort discipline; the Telegram leg reuses the
// already-proven `telegramSendMessage` primitive (TelegramMerchantNotification
// tests cover the wire shape). With no TelegramConfig/ConnectorCredentialStore
// in context, `serviceOption` resolves None and only the email channel runs.

const TENANT = TenantId("11111111-1111-1111-1111-111111111111");
const note: MerchantNotification = {
  kind: "agent_note",
  title: "Heads up",
  body: "Something the owner should know.",
  caseId: CaseId("c-1"),
};

const run = (mailLayer: Layer.Layer<never, never, never> | ReturnType<typeof makePlatformMailServiceTest>["layer"]) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* MerchantNotificationService;
        return yield* svc.notify(TENANT, note);
      }),
      MerchantNotificationLive.pipe(Layer.provide(mailLayer)),
    ),
  );

describe("MerchantNotificationLive — email channel + composition", () => {
  it("emails the merchant and reports delivery via the email channel", async () => {
    const mail = makePlatformMailServiceTest({});
    const res = await run(mail.layer);
    expect(res).toEqual({ delivered: true, channel: "email" });
    expect(mail.handle.sent).toHaveLength(1);
    expect(mail.handle.sent[0]).toMatchObject({
      kind: "merchant-notification",
      input: { title: "Heads up", body: note.body },
    });
  });

  it("reports not-delivered (no throw) when the tenant has no notificationEmail", async () => {
    const mail = makePlatformMailServiceTest({
      unconfiguredFor: new Set([TENANT]),
    });
    const res = await run(mail.layer);
    expect(res).toEqual({ delivered: false, channel: null });
  });

  it("is best-effort: a mail transport failure never throws", async () => {
    const mail = makePlatformMailServiceTest({ failAll: true });
    const res = await run(mail.layer);
    expect(res).toEqual({ delivered: false, channel: null });
  });
});
