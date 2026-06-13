import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  AccountOpenRouterCredentialStore,
  ConnectorCredentialStore,
  LLMCredentialResolver,
} from "@support-agent/services";
import {
  AccountOpenRouterCredentialStoreLive,
  ConnectorCredentialStoreLive,
  DbClientLive,
  LLMCredentialResolverLive,
  accountOpenrouterCredentials,
  connectorConnections,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("LLMCredentialResolverLive account fallback (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const organizationId = `org_${randomUUID()}`;
  const existingWorkspace = randomUUID();
  const futureWorkspace = randomUUID();
  const encryptionKey = randomBytes(32);
  const db = DbClientLive({ databaseUrl: databaseUrl! });
  const connectorStore = ConnectorCredentialStoreLive(encryptionKey).pipe(
    Layer.provide(db),
  );
  const accountStore = AccountOpenRouterCredentialStoreLive(encryptionKey).pipe(
    Layer.provide(db),
  );
  const layer = Layer.mergeAll(
    connectorStore,
    accountStore,
    LLMCredentialResolverLive.pipe(
      Layer.provide(Layer.mergeAll(connectorStore, accountStore, db)),
    ),
  );

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | AccountOpenRouterCredentialStore
      | ConnectorCredentialStore
      | LLMCredentialResolver
    >,
  ) => Effect.runPromise(Effect.provide(effect, layer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({
      id: existingWorkspace,
      name: "existing workspace",
      workosOrganizationId: organizationId,
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db
      .delete(connectorConnections)
      .where(
        sql`${connectorConnections.tenantId} IN (${existingWorkspace}, ${futureWorkspace})`,
      );
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${existingWorkspace}, ${futureWorkspace})`);
    await raw.db
      .delete(accountOpenrouterCredentials)
      .where(
        sql`${accountOpenrouterCredentials.organizationId} = ${organizationId}`,
      );
    await raw.close();
  });

  it("inherits the account key, prefers an override, then falls back after revoke", async () => {
    await run(
      Effect.gen(function* () {
        const accounts = yield* AccountOpenRouterCredentialStore;
        yield* accounts.put({
          organizationId,
          apiKey: "sk-or-v1-account",
        });
      }),
    );

    const inherited = await run(
      Effect.flatMap(LLMCredentialResolver, (r) =>
        r.resolve(TenantId(existingWorkspace)),
      ),
    );
    expect(inherited).toMatchObject({
      provider: "openrouter",
      apiKey: "sk-or-v1-account",
    });

    await run(
      Effect.gen(function* () {
        const workspaces = yield* ConnectorCredentialStore;
        yield* workspaces.put({
          tenantId: TenantId(existingWorkspace),
          provider: "openrouter",
          shopDomain: "default",
          accessToken: "sk-or-v1-workspace",
          scopes: [],
        });
      }),
    );
    const overridden = await run(
      Effect.flatMap(LLMCredentialResolver, (r) =>
        r.resolve(TenantId(existingWorkspace)),
      ),
    );
    expect(overridden.apiKey).toBe("sk-or-v1-workspace");

    await run(
      Effect.flatMap(ConnectorCredentialStore, (store) =>
        store.revoke(TenantId(existingWorkspace), "openrouter", "default"),
      ),
    );
    const fallback = await run(
      Effect.flatMap(LLMCredentialResolver, (r) =>
        r.resolve(TenantId(existingWorkspace)),
      ),
    );
    expect(fallback.apiKey).toBe("sk-or-v1-account");
  });

  it("automatically applies the account key to a workspace created later", async () => {
    await raw!.db.insert(tenants).values({
      id: futureWorkspace,
      name: "future workspace",
      workosOrganizationId: organizationId,
    });
    const resolved = await run(
      Effect.flatMap(LLMCredentialResolver, (r) =>
        r.resolve(TenantId(futureWorkspace)),
      ),
    );
    expect(resolved.apiKey).toBe("sk-or-v1-account");
  });
});
