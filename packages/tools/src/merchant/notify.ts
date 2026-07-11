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
 * Agent-initiated heads-up to the MERCHANT (never the customer), fanned out by
 * MerchantNotificationService to the operator's email AND their connected chat
 * (Telegram) when linked. The escalation valve for "I'm not sure a human would
 * agree" moments that don't warrant parking the ticket: the ticket keeps moving,
 * the merchant just gets pinged.
 *
 * Auto-allowed on purpose — its whole point is reaching the human, so
 * gating it behind that same human's approval would be circular. It is
 * also kept internal (no `tenantControl`): the merchant "configures" it
 * via their notification email + linking/unlinking Telegram in the dashboard.
 */
export const merchantNotify = defineTool({
  name: "merchant.notify",
  description:
    "Send a short heads-up to the STORE OWNER (the merchant), emailed to them and, if they've linked a chat (Telegram), pushed there too. Use it when you are unsure about something a human should weigh in on, or when you notice something the merchant should know about (a claim you cannot verify, a suspicious pattern, a gap in the store's policies). `title` is a one-line headline; `message` is 1–3 plain-text sentences. This does NOT message the customer and does NOT pause the ticket, continue handling the ticket normally after calling it. `delivered: false` means no channel reached the merchant (no notification email set and no chat linked); do not retry, just proceed.",
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
          ticketId: ctx.ticketId,
        })
        .pipe(Effect.mapError((cause) => new NetworkError({ cause })));
      return { delivered: result.delivered };
    }),
});
