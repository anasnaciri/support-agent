import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { TenantId, TicketId } from "@support-agent/agent-core";
import {
  ConnectorCredentialStoreTest,
  MerchantNotificationSendFailed,
  MerchantNotificationService,
  type ConnectorConnection,
  type MerchantNotification,
} from "@support-agent/services";
import {
  TelegramConfig,
  TelegramMerchantNotificationLive,
} from "../src/telegram-notification-live.js";

const okResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => '{"ok":true,"result":{"message_id":42}}',
    json: async () => ({ ok: true, result: { message_id: 42 } }),
  }) as unknown as Response;

const failResponse = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  }) as unknown as Response;

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");

const telegramBinding = (
  overrides: Partial<ConnectorConnection> = {},
): ConnectorConnection => ({
  tenantId,
  provider: "telegram",
  shopDomain: "987654321",
  accessToken: "987654321",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata: { username: "merchant_jane" },
  scopes: [],
  apiVersion: null,
  installedAt: new Date("2026-06-01T00:00:00Z"),
  status: "active",
  ...overrides,
});

const configWith = (fetchImpl: typeof fetch): Layer.Layer<TelegramConfig> =>
  Layer.succeed(TelegramConfig, {
    botToken: "123456:bot-secret",
    botUsername: "support_agent_bot",
    webhookSecret: "hook-secret",
    fetchImpl,
  });

const note: MerchantNotification = {
  kind: "agent_note",
  title: "Agent needs a sanity check",
  body: "Customer cites promo code SAVE50 which is not in the knowledge base.",
  ticketId: TicketId("caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
};

const layerWith = (
  fetchImpl: typeof fetch,
  seed: ReadonlyArray<ConnectorConnection>,
): Layer.Layer<MerchantNotificationService> =>
  TelegramMerchantNotificationLive.pipe(
    Layer.provide(
      Layer.mergeAll(configWith(fetchImpl), ConnectorCredentialStoreTest(seed)),
    ),
  );

const notify = (layer: Layer.Layer<MerchantNotificationService>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* MerchantNotificationService;
        return yield* Effect.either(svc.notify(tenantId, note));
      }),
      layer,
    ),
  );

describe("TelegramMerchantNotificationLive", () => {
  it("POSTs sendMessage to the bound chat with plain title+body text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const result = await notify(layerWith(fetchImpl, [telegramBinding()]));

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toEqual({ delivered: true, channel: "telegram" });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api.telegram.org/bot123456:bot-secret/sendMessage",
    );
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body["chat_id"]).toBe("987654321");
    expect(body["text"]).toContain("Agent needs a sanity check");
    expect(body["text"]).toContain("promo code SAVE50");
    // Plain text only — no parse_mode means Telegram can't interpret
    // customer-derived content as markup.
    expect(body).not.toHaveProperty("parse_mode");
  });

  it("returns delivered:false when the tenant has no telegram binding", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const result = await notify(layerWith(fetchImpl, []));

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toEqual({ delivered: false, channel: null });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns delivered:false when the binding is revoked", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const result = await notify(
      layerWith(fetchImpl, [telegramBinding({ status: "revoked" })]),
    );

    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toEqual({ delivered: false, channel: null });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a Telegram API error into MerchantNotificationSendFailed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        failResponse(403, '{"ok":false,"description":"bot was blocked"}'),
      );
    const result = await notify(layerWith(fetchImpl, [telegramBinding()]));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(MerchantNotificationSendFailed);
    }
  });
});
