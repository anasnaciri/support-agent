import { Context, Effect, Layer } from "effect";
import {
  ConnectorCredentialStore,
  MerchantNotificationSendFailed,
  MerchantNotificationService,
  type MerchantNotifyResult,
} from "@support-agent/services";

// ============================================================
// TelegramConfig Tag
// ============================================================
//
// Platform-level bot identity — ONE bot serves every tenant (the
// per-tenant part is the chat binding row in `connector_connections`,
// provider "telegram"). Kept distinct from `MerchantNotificationService`
// so the abstract Tag doesn't leak Telegram shape; a Slack channel later
// gets its own Config Tag + Live Layer providing the same service.
//
// `webhookSecret` and `botUsername` aren't used by this Layer — they're
// carried here so apps/api (webhook verification, t.me deep links) and
// this Layer share one config source.

export class TelegramConfig extends Context.Tag("TelegramConfig")<
  TelegramConfig,
  {
    /** Bot API token from @BotFather (`<digits>:<secret>`). */
    readonly botToken: string;
    /** Bot username WITHOUT the `@` — used to build t.me deep links. */
    readonly botUsername: string;
    /** Expected value of X-Telegram-Bot-API-Secret-Token on webhook calls. */
    readonly webhookSecret: string;
    /** Override for tests; production uses global `fetch`. */
    readonly fetchImpl?: typeof fetch;
  }
>() {}

// ============================================================
// Telegram Live layer for MerchantNotificationService
// ============================================================

const TELEGRAM_API_BASE = "https://api.telegram.org";

const safeBody = async (res: Response): Promise<unknown> => {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/**
 * Bare POST to the Bot API. Exported for the api-side linking webhook
 * (sending the "you're connected" confirmation) so the wire shape lives
 * in exactly one place.
 */
export const telegramSendMessage = (input: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly fetchImpl?: typeof fetch;
}): Effect.Effect<void, { readonly status?: number; readonly body?: unknown; readonly cause?: unknown }> =>
  Effect.gen(function* () {
    const fetchImpl = input.fetchImpl ?? fetch;
    const res = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`${TELEGRAM_API_BASE}/bot${input.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Plain text on purpose: no `parse_mode`, so customer-derived
          // content in the body can never be interpreted as markup.
          body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
        }),
      catch: (cause) => ({ cause }),
    });
    if (!res.ok) {
      const body = yield* Effect.promise(() => safeBody(res));
      return yield* Effect.fail({ status: res.status, body });
    }
  });

export const TelegramMerchantNotificationLive = Layer.effect(
  MerchantNotificationService,
  Effect.gen(function* () {
    const config = yield* TelegramConfig;
    const store = yield* ConnectorCredentialStore;

    return MerchantNotificationService.of({
      notify: (tenantId, notification) =>
        Effect.gen(function* () {
          // Resolve the tenant's chat binding. Missing or revoked binding
          // is the "not connected" case, not a failure — callers are
          // best-effort emitters and the merchant.notify tool wants to
          // report non-delivery to the agent, not crash the tick.
          const binding = yield* store.get(tenantId, "telegram").pipe(
            Effect.catchTag("ConnectorNotFound", () => Effect.succeed(null)),
            Effect.catchTag("ConnectorRevoked", () => Effect.succeed(null)),
            // A ConnectorStoreDbError IS a failure, not "not connected".
            Effect.mapError(
              (cause) =>
                new MerchantNotificationSendFailed({ tenantId, cause }),
            ),
          );
          if (binding === null) {
            return { delivered: false, channel: null } as MerchantNotifyResult;
          }

          const text = `${notification.title}\n\n${notification.body}`;
          yield* telegramSendMessage({
            botToken: config.botToken,
            chatId: binding.accessToken,
            text,
            ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
          }).pipe(
            Effect.mapError(
              (cause) => new MerchantNotificationSendFailed({ tenantId, cause }),
            ),
          );
          return {
            delivered: true,
            channel: "telegram",
          } as MerchantNotifyResult;
        }),
    });
  }),
);

// ============================================================
// Env-driven config helper
// ============================================================
//
// All-or-nothing: the worker/api decide whether to wire the Telegram
// layer at all (absent token → notifications disabled, a no-op layer is
// provided instead); once wired, a partial config is a deploy mistake
// and fails loudly.

export const TelegramConfigFromEnv = Layer.effect(
  TelegramConfig,
  Effect.sync(() => {
    const botToken = process.env["TELEGRAM_BOT_TOKEN"];
    const botUsername = process.env["TELEGRAM_BOT_USERNAME"];
    const webhookSecret = process.env["TELEGRAM_WEBHOOK_SECRET"];
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
    if (!botUsername) throw new Error("TELEGRAM_BOT_USERNAME is required");
    if (!webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
    return { botToken, botUsername, webhookSecret };
  }),
);

/**
 * No-op fallback for deployments without a Telegram bot configured:
 * every notify reports `delivered: false`, so emitters and the
 * `merchant.notify` tool degrade exactly like "tenant not linked".
 */
export const MerchantNotificationNoopLive = Layer.succeed(
  MerchantNotificationService,
  MerchantNotificationService.of({
    notify: () => Effect.succeed({ delivered: false, channel: null }),
  }),
);
