import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorCredentialStore,
  ConnectorCredentialStoreTest,
  type ConnectorConnection,
} from "@support-agent/services";
import {
  isTelegramWebhookAuthorized,
  processTelegramUpdate,
} from "../webhook.js";
import {
  TELEGRAM_LINK_TTL_MS,
  mintTelegramLinkToken,
} from "../link.js";

const key = "test-signing-key";
const tenantId = "11111111-2222-3333-4444-555555555555";
const now = Date.parse("2026-06-12T12:00:00.000Z");

const okResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => '{"ok":true}',
    json: async () => ({ ok: true }),
  }) as unknown as Response;

const startUpdate = (token: string, chatId = 987654321) => ({
  update_id: 1,
  message: {
    message_id: 10,
    text: `/start ${token}`,
    chat: { id: chatId, type: "private", username: "merchant_jane" },
    from: { id: chatId, first_name: "Jane", username: "merchant_jane" },
  },
});

const deps = (fetchImpl: typeof fetch) => ({
  signingKey: key,
  botToken: "123:bot",
  fetchImpl,
  now: () => new Date(now),
});

const run = (
  update: unknown,
  fetchImpl: typeof fetch,
  seed: ReadonlyArray<ConnectorConnection> = [],
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const outcome = yield* processTelegramUpdate(update, deps(fetchImpl));
        const store = yield* ConnectorCredentialStore;
        const rows = yield* store.listForTenant(tenantId as never);
        return { outcome, rows };
      }),
      Layer.mergeAll(ConnectorCredentialStoreTest(seed)),
    ),
  );

describe("isTelegramWebhookAuthorized", () => {
  it("accepts only the configured secret header", () => {
    expect(isTelegramWebhookAuthorized("s3cret", "s3cret")).toBe(true);
    expect(isTelegramWebhookAuthorized("wrong", "s3cret")).toBe(false);
    expect(isTelegramWebhookAuthorized(undefined, "s3cret")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(isTelegramWebhookAuthorized("anything", "")).toBe(false);
    expect(isTelegramWebhookAuthorized(undefined, "")).toBe(false);
  });
});

describe("processTelegramUpdate", () => {
  it("binds the chat on a valid /start and sends a confirmation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const token = mintTelegramLinkToken(key, tenantId, now + TELEGRAM_LINK_TTL_MS);
    const { outcome, rows } = await run(startUpdate(token), fetchImpl);

    expect(outcome).toBe("linked");
    const binding = rows.find((r) => r.provider === "telegram");
    expect(binding).toBeDefined();
    expect(binding!.status).toBe("active");
    expect(binding!.shopDomain).toBe("987654321");
    expect(binding!.accessToken).toBe("987654321");
    expect(binding!.metadata["username"]).toBe("merchant_jane");

    // Confirmation message went to the linked chat.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/bot123:bot/sendMessage");
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body["chat_id"]).toBe("987654321");
  });

  it("re-linking from a NEW chat revokes the previous binding (one chat per workspace)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const token = mintTelegramLinkToken(key, tenantId, now + TELEGRAM_LINK_TTL_MS);
    const prior: ConnectorConnection = {
      tenantId: tenantId as never,
      provider: "telegram",
      shopDomain: "111",
      accessToken: "111",
      refreshToken: null,
      tokenExpiresAt: null,
      metadata: {},
      scopes: [],
      apiVersion: null,
      installedAt: new Date(now - 1000),
      status: "active",
    };
    const { outcome, rows } = await run(
      startUpdate(token, 222),
      fetchImpl,
      [prior],
    );

    expect(outcome).toBe("linked");
    expect(
      rows.find((r) => r.provider === "telegram" && r.shopDomain === "111")
        ?.status,
    ).toBe("revoked");
    expect(
      rows.find((r) => r.provider === "telegram" && r.shopDomain === "222")
        ?.status,
    ).toBe("active");
  });

  it("rejects an expired/invalid token without binding anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const expired = mintTelegramLinkToken(key, tenantId, now - 1);
    const { outcome, rows } = await run(startUpdate(expired), fetchImpl);

    expect(outcome).toBe("invalid_token");
    expect(rows.find((r) => r.provider === "telegram")).toBeUndefined();
    // Polite "expired" message still goes back to the chat.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores non-/start updates", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const { outcome } = await run(
      { update_id: 2, message: { text: "hello", chat: { id: 1 } } },
      fetchImpl,
    );
    expect(outcome).toBe("ignored");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores malformed updates without crashing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const { outcome } = await run({ bogus: true }, fetchImpl);
    expect(outcome).toBe("ignored");
  });
});
