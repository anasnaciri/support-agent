import { Effect, Schema } from "effect";
import { defineTool, NetworkError } from "@support-agent/agent-core";
import { MerchantNotificationService } from "@support-agent/services";

const Input = Schema.Struct({
  title: Schema.String,
  message: Schema.String,
});

const Output = Schema.Struct({
  delivered: Schema.Boolean,
});

/**
 * Agent-initiated heads-up to the MERCHANT (never the customer) over the
 * tenant's connected chat channel (Telegram). The escalation valve for
 * "I'm not sure a human would agree" moments that don't warrant parking
 * the case: the case keeps moving, the merchant just gets pinged.
 *
 * Auto-allowed on purpose — its whole point is reaching the human, so
 * gating it behind that same human's approval would be circular. It is
 * also kept internal (no `tenantControl`): the merchant "configures" it
 * by connecting or disconnecting their Telegram in the dashboard.
 */
export const merchantNotify = defineTool({
  name: "merchant.notify",
  description:
    "Send a short push notification to the STORE OWNER (the merchant) on their connected chat channel. Use it when you are unsure about something a human should weigh in on, or when you notice something the merchant should know about (a claim you cannot verify, a suspicious pattern, a gap in the store's policies). `title` is a one-line headline; `message` is 1–3 plain-text sentences. This does NOT message the customer and does NOT pause the case — continue handling the case normally after calling it. `delivered: false` means the merchant has no notification channel connected; do not retry, just proceed.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  defaultPermission: "allow",
  sideEffectClass: "external_message",
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const notifications = yield* MerchantNotificationService;
      const result = yield* notifications
        .notify(ctx.tenantId, {
          kind: "agent_note",
          title: input.title,
          body: input.message,
          caseId: ctx.caseId,
        })
        .pipe(Effect.mapError((cause) => new NetworkError({ cause })));
      return { delivered: result.delivered };
    }),
});
