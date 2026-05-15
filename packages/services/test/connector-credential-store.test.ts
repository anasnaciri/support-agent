import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  ConnectorNotFound,
  ConnectorRevoked,
  TenantId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  ConnectorCredentialStoreTest,
} from "../src/index.js";

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");
const otherTenantId = TenantId("22222222-2222-2222-2222-222222222222");

describe("ConnectorCredentialStore (Test layer)", () => {
  it("put → get returns the same connection", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId,
            provider: "shopify",
            shopDomain: "demo.myshopify.com",
            accessToken: "tok-1",
            scopes: ["read_orders"],
            apiVersion: "2025-01",
          });
          return yield* store.get(tenantId, "shopify", "demo.myshopify.com");
        }),
        ConnectorCredentialStoreTest(),
      ),
    );
    expect(out.accessToken).toBe("tok-1");
    expect(out.apiVersion).toBe("2025-01");
    expect(out.status).toBe("active");
  });

  it("get without shopDomain returns the first matching (tenant, provider)", async () => {
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId,
            provider: "shopify",
            shopDomain: "one.myshopify.com",
            accessToken: "tok-A",
            scopes: [],
          });
          return yield* store.get(tenantId, "shopify");
        }),
        ConnectorCredentialStoreTest(),
      ),
    );
    expect(out.accessToken).toBe("tok-A");
  });

  it("get for a missing connector → ConnectorNotFound", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          return yield* store.get(otherTenantId, "shopify", "missing");
        }),
        ConnectorCredentialStoreTest(),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ConnectorNotFound);
    }
  });

  it("revoke + get → ConnectorRevoked", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId,
            provider: "shopify",
            shopDomain: "doomed.myshopify.com",
            accessToken: "tok-revoke",
            scopes: [],
          });
          yield* store.revoke(tenantId, "shopify", "doomed.myshopify.com");
          return yield* store.get(tenantId, "shopify", "doomed.myshopify.com");
        }),
        ConnectorCredentialStoreTest(),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ConnectorRevoked);
    }
  });

  it("listForTenant filters by tenant", async () => {
    const list = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* ConnectorCredentialStore;
          yield* store.put({
            tenantId,
            provider: "shopify",
            shopDomain: "a.myshopify.com",
            accessToken: "a",
            scopes: [],
          });
          yield* store.put({
            tenantId: otherTenantId,
            provider: "shopify",
            shopDomain: "b.myshopify.com",
            accessToken: "b",
            scopes: [],
          });
          return yield* store.listForTenant(tenantId);
        }),
        ConnectorCredentialStoreTest(),
      ),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.shopDomain).toBe("a.myshopify.com");
  });
});
