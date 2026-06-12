import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorCredentialStore,
  ConnectorCredentialStoreTest,
  makeMerchantNotificationServiceTest,
  type ConnectorConnection,
} from "@support-agent/services";
import {
  checkOpenRouterCredits,
  decideCreditsAlert,
} from "../src/llm-credits.js";

// llm_credits_low — a tenant on a prepaid OpenRouter key silently stops
// the moment credits hit zero (every tick lands in human_takeover with
// llm_credential_* noise). The cron warns the merchant BEFORE that
// cliff, exactly once per below-threshold crossing.

const at = new Date("2026-06-12T12:00:00.000Z");

const openrouterRow = (
  metadata: Readonly<Record<string, unknown>> = {},
): ConnectorConnection => ({
  tenantId: "t1" as never,
  provider: "openrouter",
  shopDomain: "openrouter",
  accessToken: "sk-or-test-key",
  refreshToken: null,
  tokenExpiresAt: null,
  metadata,
  scopes: [],
  apiVersion: null,
  installedAt: at,
  status: "active",
});

const creditsResponse = (total: number, usage: number): Response =>
  ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ data: { total_credits: total, total_usage: usage } }),
    json: async () => ({ data: { total_credits: total, total_usage: usage } }),
  }) as unknown as Response;

const failResponse = (status: number): Response =>
  ({
    ok: false,
    status,
    text: async () => "nope",
    json: async () => ({}),
  }) as unknown as Response;

describe("decideCreditsAlert (pure)", () => {
  it("alerts on the first below-threshold crossing", () => {
    const d = decideCreditsAlert(false, 2.5, 5);
    expect(d.alert).toBe(true);
  });

  it("does not re-alert while still below threshold", () => {
    const d = decideCreditsAlert(true, 2.5, 5);
    expect(d.alert).toBe(false);
    expect(d.rearm).toBe(false);
  });

  it("re-arms once the balance recovers above threshold", () => {
    const d = decideCreditsAlert(true, 12, 5);
    expect(d.alert).toBe(false);
    expect(d.rearm).toBe(true);
  });

  it("does nothing while healthy", () => {
    const d = decideCreditsAlert(false, 12, 5);
    expect(d.alert).toBe(false);
    expect(d.rearm).toBe(false);
  });
});

describe("checkOpenRouterCredits", () => {
  const run = (
    seed: ReadonlyArray<ConnectorConnection>,
    fetchImpl: typeof fetch,
    notifLayer: Layer.Layer<never, never, never>,
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const results = yield* checkOpenRouterCredits(
            seed.map((r) => ({
              tenantId: r.tenantId as string,
              shopDomain: r.shopDomain,
            })),
            { thresholdUsd: 5, fetchImpl },
          );
          const store = yield* ConnectorCredentialStore;
          const rows = yield* Effect.forEach(seed, (r) =>
            store.get(r.tenantId, "openrouter", r.shopDomain),
          );
          return { results, rows };
        }),
        Layer.mergeAll(
          ConnectorCredentialStoreTest(seed),
          notifLayer as never,
        ),
      ) as Effect.Effect<never, never, never>,
    ) as Promise<{
      results: ReadonlyArray<{ tenantId: string; outcome: unknown }>;
      rows: ReadonlyArray<ConnectorConnection>;
    }>;

  it("notifies once and stamps the alert flag when below threshold", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(creditsResponse(10, 7.5));
    const out = await run([openrouterRow()], fetchImpl, notifLayer as never);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/credits");
    expect(
      (init?.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer sk-or-test-key");

    expect(out.results[0]?.outcome).toBe("alerted");
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]?.notification.kind).toBe("llm_credits_low");
    expect(handle.sent[0]?.notification.body).toContain("$2.50");
    expect(out.rows[0]?.metadata["llmCreditsAlertActive"]).toBe(true);
  });

  it("does not re-notify while the alert flag is set", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(creditsResponse(10, 7.5));
    const out = await run(
      [openrouterRow({ llmCreditsAlertActive: true })],
      fetchImpl,
      notifLayer as never,
    );
    expect(out.results[0]?.outcome).toBe("already_alerted");
    expect(handle.sent).toHaveLength(0);
  });

  it("re-arms the flag once the balance recovers", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(creditsResponse(50, 7.5));
    const out = await run(
      [openrouterRow({ llmCreditsAlertActive: true })],
      fetchImpl,
      notifLayer as never,
    );
    expect(out.results[0]?.outcome).toBe("rearmed");
    expect(handle.sent).toHaveLength(0);
    expect(out.rows[0]?.metadata["llmCreditsAlertActive"]).toBe(false);
  });

  it("does NOT stamp the flag when the merchant has no channel connected", async () => {
    // Otherwise connecting Telegram later would never produce the alert
    // that was 'sent' into the void; the next pass retries instead.
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest({
      disconnectedFor: new Set(["t1" as never]),
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(creditsResponse(10, 7.5));
    const out = await run([openrouterRow()], fetchImpl, notifLayer as never);
    expect(out.results[0]?.outcome).toBe("no_channel");
    expect(handle.sent).toHaveLength(1); // attempt recorded, undelivered
    expect(out.rows[0]?.metadata["llmCreditsAlertActive"]).toBeUndefined();
  });

  it("skips unreadable balances without alerting or patching", async () => {
    const { layer: notifLayer, handle } = makeMerchantNotificationServiceTest();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(failResponse(401));
    const out = await run([openrouterRow()], fetchImpl, notifLayer as never);
    expect(out.results[0]?.outcome).toEqual({ failed: "credits_unreadable" });
    expect(handle.sent).toHaveLength(0);
    expect(out.rows[0]?.metadata["llmCreditsAlertActive"]).toBeUndefined();
  });
});
