import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Exit, Layer } from "effect";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import { ConnectorCredentialStore } from "@support-agent/services";
import {
  ConnectorCredentialStoreLive,
  DbClient,
  DbClientLive,
  connectorConnections,
  isActiveLlmProviderConflict,
  makeDbClient,
  tenants,
} from "../src/index.js";

// Audit D3 (patchMetadata's SELECT FOR UPDATE must live inside a real
// transaction) and D11 (BYOK active-LLM unique violation → typed conflict),
// against the Live store. Gated on DATABASE_URL.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ConnectorCredentialStore (audit fixes, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const encryptionKey = randomBytes(32);

  const liveLayer = Layer.provide(
    ConnectorCredentialStoreLive(encryptionKey),
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  const run = <A, E>(
    eff: Effect.Effect<A, E, ConnectorCredentialStore | DbClient>,
  ) => Effect.runPromise(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  const runExit = <A, E>(
    eff: Effect.Effect<A, E, ConnectorCredentialStore | DbClient>,
  ) =>
    Effect.runPromiseExit(Effect.provide(eff, liveLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values({ id: tenantId, name: "connector-audit-test" });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(connectorConnections)
      .where(sql`${connectorConnections.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("D3: concurrent patchMetadata calls don't lose each other's keys", async () => {
    const mailbox = `d3-${randomUUID()}@example.com`;
    await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "gmail",
          shopDomain: mailbox,
          accessToken: "tok",
          scopes: [],
          metadata: { seed: true },
        });
      }),
    );

    const keys = Array.from({ length: 8 }, (_, i) => `k${i}`);
    await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* Effect.all(
          keys.map((k) =>
            store.patchMetadata({
              tenantId: TenantId(tenantId),
              provider: "gmail",
              shopDomain: mailbox,
              metadata: { [k]: k },
            }),
          ),
          { concurrency: "unbounded" },
        );
      }),
    );

    const after = await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.get(TenantId(tenantId), "gmail", mailbox);
      }),
    );
    for (const k of keys) {
      expect(after.metadata[k], `metadata key ${k} was lost`).toBe(k);
    }
    expect(after.metadata["seed"]).toBe(true);
  });

  it("D11: second active LLM provider surfaces a typed conflict, not a raw db error", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "openrouter",
          shopDomain: "",
          accessToken: "sk-or-1",
          scopes: [],
        });
      }),
    );

    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* ConnectorCredentialStore;
        return yield* store.put({
          tenantId: TenantId(tenantId),
          provider: "anthropic",
          shopDomain: "",
          accessToken: "sk-ant-1",
          scopes: [],
        });
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(isActiveLlmProviderConflict(err)).toBe(true);
    }
  });
});
