import { Effect, FiberRef, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import {
  TenantAgentOverridesService,
  type AgentOverride,
} from "@support-agent/services";
import {
  AgentId as makeAgentId,
  ConnectorStoreDbError,
  type AgentId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import {
  tenantAgentOverrides,
  type TenantAgentOverrideRow,
} from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  promise: Promise<A>,
): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const rowToOverride = (r: TenantAgentOverrideRow): AgentOverride => ({
  agentId: makeAgentId(r.agentId),
  model: r.model,
  updatedAt: r.updatedAt,
});

export const TenantAgentOverridesServiceLive = Layer.effect(
  TenantAgentOverridesService,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    return TenantAgentOverridesService.of({
      getForTenant: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantAgentOverrides)
              .where(eq(tenantAgentOverrides.tenantId, tenantId)),
          );
          const map = new Map<AgentId, AgentOverride>();
          for (const row of rows) {
            const override = rowToOverride(row);
            map.set(override.agentId, override);
          }
          return map;
        }),

      setModel: (tenantId: TenantId, agentId: AgentId, model: string) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const now = new Date();
          yield* wrap(
            db
              .insert(tenantAgentOverrides)
              .values({
                tenantId,
                agentId,
                model,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  tenantAgentOverrides.tenantId,
                  tenantAgentOverrides.agentId,
                ],
                set: { model, updatedAt: now },
              }),
          );
        }),

      clearModel: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          yield* wrap(
            db
              .delete(tenantAgentOverrides)
              .where(
                and(
                  eq(tenantAgentOverrides.tenantId, tenantId),
                  eq(tenantAgentOverrides.agentId, agentId),
                ),
              ),
          );
        }),
    });
  }),
);
