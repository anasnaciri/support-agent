import "server-only";
import { Effect, Layer } from "effect";
import {
  DbClientLive,
  ConnectorCredentialStoreLive,
} from "@support-agent/db";
import { parseKey, ShopifyService } from "@support-agent/services";
import {
  ShopifyHttpLive,
  ShopifyServiceLive,
  ShopifyCredentialStoreFromConnector,
} from "@support-agent/providers";

// Effect Layer chain that gives the dashboard a working `ShopifyService`
// against the merchant's managed-install credentials. Mirrors the
// `apps/worker/src/bootstrap.ts` wiring; we just don't need permission /
// runtime / agent layers here since we only call read methods.
//
// Built lazily on first use and cached for the lifetime of the Node
// process. If CREDENTIAL_ENCRYPTION_KEY or DATABASE_URL is unset the
// helper returns `null` rather than throwing — Shopify panels then
// fall back to "not connected" copy instead of breaking the case page.

const buildLayer = (): Layer.Layer<ShopifyService> | null => {
  const databaseUrl = process.env["DATABASE_URL"];
  const credKeyB64 = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  if (!databaseUrl || !credKeyB64) return null;
  const db = DbClientLive({ databaseUrl });
  const credStore = ConnectorCredentialStoreLive(parseKey(credKeyB64)).pipe(
    Layer.provide(db),
  );
  const shopifyCreds = ShopifyCredentialStoreFromConnector().pipe(
    Layer.provide(credStore),
  );
  return ShopifyServiceLive.pipe(
    Layer.provide(Layer.mergeAll(ShopifyHttpLive, shopifyCreds)),
  );
};

let cached: Layer.Layer<ShopifyService> | null | undefined;

const getLayer = (): Layer.Layer<ShopifyService> | null => {
  if (cached === undefined) cached = buildLayer();
  return cached;
};

export const runShopify = async <A, E>(
  eff: Effect.Effect<A, E, ShopifyService>,
): Promise<A | null> => {
  const layer = getLayer();
  if (!layer) return null;
  const exit = await Effect.runPromiseExit(Effect.provide(eff, layer));
  if (exit._tag === "Failure") return null;
  return exit.value;
};
