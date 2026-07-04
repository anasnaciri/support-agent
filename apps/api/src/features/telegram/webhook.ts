import { Effect } from "effect";
import { TenantId } from "@support-agent/agent-core";
import { ConnectorCredentialStore } from "@support-agent/services";
import { telegramSendMessage } from "@support-agent/providers";
import { verifyTelegramLinkToken } from "./link.js";

// ============================================================
// Telegram bot webhook — chat linking
// ============================================================
//
// One platform bot serves every tenant. The only update we act on is
// `/start <signed-token>` (from the dashboard's t.me deep link): it
// binds the sending chat to the token's tenant in
// `connector_connections` (provider "telegram"). Everything else is
// acknowledged and ignored — the bot is a one-way notification
// channel, not a conversational surface.

/**
 * Telegram authenticates webhook calls solely via the
 * `X-Telegram-Bot-API-Secret-Token` header (set when registering the
 * webhook). No secret configured → reject everything (fail closed,
 * same rule as the Graph webhook, audit S4).
 */
export const isTelegramWebhookAuthorized = (
  headerValue: string | undefined,
  expectedSecret: string,
): boolean =>
  expectedSecret.length > 0 && headerValue === expectedSecret;

export type TelegramUpdateOutcome = "linked" | "invalid_token" | "ignored";

interface TelegramStart {
  readonly token: string;
  readonly chatId: string;
  readonly username: string | null;
  readonly firstName: string | null;
}

/** Pull `/start <token>` + chat identity out of an untrusted update. */
const parseStart = (update: unknown): TelegramStart | null => {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const m = message as {
    text?: unknown;
    chat?: { id?: unknown; username?: unknown };
    from?: { first_name?: unknown; username?: unknown };
  };
  if (typeof m.text !== "string" || !m.text.startsWith("/start ")) return null;
  const chatId = m.chat?.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return null;
  const token = m.text.slice("/start ".length).trim();
  if (!token) return null;
  const username =
    typeof m.from?.username === "string"
      ? m.from.username
      : typeof m.chat?.username === "string"
        ? m.chat.username
        : null;
  return {
    token,
    chatId: String(chatId),
    username,
    firstName: typeof m.from?.first_name === "string" ? m.from.first_name : null,
  };
};

export interface ProcessTelegramUpdateDeps {
  readonly signingKey: string;
  readonly botToken: string;
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Handle one (already-authenticated) update. Always succeeds — Telegram
 * retries non-2xx deliveries, and there is nothing a retry would fix.
 */
export const processTelegramUpdate = (
  update: unknown,
  deps: ProcessTelegramUpdateDeps,
): Effect.Effect<TelegramUpdateOutcome, never, ConnectorCredentialStore> =>
  Effect.gen(function* () {
    const start = parseStart(update);
    if (!start) return "ignored" as const;

    const reply = (text: string): Effect.Effect<void> =>
      telegramSendMessage({
        botToken: deps.botToken,
        chatId: start.chatId,
        text,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }).pipe(Effect.ignore);

    const nowMs = (deps.now ?? (() => new Date()))().getTime();
    const verified = verifyTelegramLinkToken(
      deps.signingKey,
      start.token,
      nowMs,
    );
    if (!verified) {
      yield* reply(
        "This link is invalid or has expired. Open your dashboard's notification settings and generate a fresh one.",
      );
      return "invalid_token" as const;
    }

    const tenantId = TenantId(verified.tenantId);
    const store = yield* ConnectorCredentialStore;

    // One chat per workspace: the latest /start wins, so a re-link from
    // a new chat revokes the previous binding instead of leaving two
    // active rows for the bare `get(tenant, "telegram")` to race over.
    const outcome = yield* Effect.gen(function* () {
      const rows = yield* store.listForTenant(tenantId);
      const stale = rows.filter(
        (r) =>
          r.provider === "telegram" &&
          r.status === "active" &&
          r.shopDomain !== start.chatId,
      );
      for (const row of stale) {
        yield* store.revoke(tenantId, "telegram", row.shopDomain);
      }
      yield* store.put({
        tenantId,
        provider: "telegram",
        shopDomain: start.chatId,
        accessToken: start.chatId,
        refreshToken: null,
        tokenExpiresAt: null,
        scopes: [],
        metadata: {
          username: start.username,
          firstName: start.firstName,
          linkedAt: new Date(nowMs).toISOString(),
        },
      });
      return "linked" as const;
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.logError(
          `[telegram webhook] failed to persist binding: ${String(cause)}`,
        ).pipe(Effect.as("ignored" as const)),
      ),
    );

    if (outcome === "linked") {
      yield* reply(
        "You're connected. This chat now receives your support agent's notifications — approval requests, tickets that need you, and account alerts. Disconnect any time from the dashboard's notification settings.",
      );
    }
    return outcome;
  });
