import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  ShopifyCredentialStore,
  ShopifyService,
} from "@support-agent/services";
import {
  ShopifyHttpLive,
  ShopifyServiceLive,
  ShopifyCredentialStoreFromEnv,
} from "../src/shopify-service-live.js";

// Real-call smoke test. Hits the configured Shopify dev store through
// `ShopifyServiceLive` to prove that domain + token + API version + the
// GraphQL request all line up. Gated on `SHOPIFY_TEST_SHOP_DOMAIN` +
// `SHOPIFY_TEST_ACCESS_TOKEN` so CI / local runs without a real store
// still pass.
//
// We probe with `searchByEmail` for an email that almost certainly does
// not exist — the API will respond `customers.nodes: []` regardless of
// what's in the store, so the test is data-independent. A 401 or
// connection failure will fail loudly.
const shopDomain = process.env["SHOPIFY_TEST_SHOP_DOMAIN"];
const accessToken = process.env["SHOPIFY_TEST_ACCESS_TOKEN"];
const describeIfCreds =
  shopDomain && accessToken ? describe : describe.skip;

describeIfCreds("ShopifyServiceLive — real Shopify Admin smoke test", () => {
  const live = ShopifyServiceLive.pipe(
    Layer.provide(Layer.merge(ShopifyHttpLive, ShopifyCredentialStoreFromEnv)),
  );

  it(
    "completes a searchByEmail round-trip without auth errors",
    async () => {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(ShopifyService, (s) =>
            s.searchByEmail(
              TenantId("smoke-tenant"),
              "definitely-not-a-real-customer-xyz@example.invalid",
            ),
          ),
          live,
        ),
      );
      // The email is intentionally invalid; expect null (no match) without
      // hitting auth or network errors.
      expect(result).toBeNull();
      // eslint-disable-next-line no-console -- intentional smoke signal
      console.log(`[smoke] searchByEmail on ${shopDomain} -> null (ok)`);
    },
    30_000,
  );

  it(
    "credentials.store is wired through and returns the env values",
    async () => {
      const creds = await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(ShopifyCredentialStore, (s) =>
            s.get(TenantId("smoke-tenant")),
          ),
          ShopifyCredentialStoreFromEnv,
        ),
      );
      expect(creds.shopDomain).toBe(shopDomain);
      expect(creds.accessToken).toBe(accessToken);
      expect(creds.apiVersion.length).toBeGreaterThan(0);
    },
    5_000,
  );
});
