import { Effect, FiberRef, Layer } from "effect";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  TenantAgentOverridesService,
  type AgentOverride,
} from "@support-agent/services";
import {
  AgentId as makeAgentId,
  ConnectorStoreDbError,
  type AgentId,
  type Permission,
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
  systemPrompt: r.systemPrompt,
  toolPermissions: r.toolPermissions,
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

      // Field-aware clear: null the model but KEEP a sibling system prompt,
      // then remove the row only when both overridable fields are null (so
      // "Reset model" never wipes a tenant's custom prompt). UPDATE and
      // DELETE share ONE transaction and the DELETE re-checks the just-
      // cleared column (audit D10): as two autocommit statements, a
      // concurrent setModel landing between them would have its fresh row
      // deleted.
      clearModel: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const where = and(
            eq(tenantAgentOverrides.tenantId, tenantId),
            eq(tenantAgentOverrides.agentId, agentId),
          );
          yield* wrap(
            db.transaction(async (tx) => {
              await tx
                .update(tenantAgentOverrides)
                .set({ model: null, updatedAt: new Date() })
                .where(where);
              await tx
                .delete(tenantAgentOverrides)
                .where(
                  and(
                    where,
                    isNull(tenantAgentOverrides.model),
                    isNull(tenantAgentOverrides.systemPrompt),
                    isNull(tenantAgentOverrides.toolPermissions),
                  ),
                );
            }),
          );
        }),

      setSystemPrompt: (
        tenantId: TenantId,
        agentId: AgentId,
        systemPrompt: string,
      ) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const now = new Date();
          yield* wrap(
            db
              .insert(tenantAgentOverrides)
              .values({
                tenantId,
                agentId,
                systemPrompt,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [
                  tenantAgentOverrides.tenantId,
                  tenantAgentOverrides.agentId,
                ],
                set: { systemPrompt, updatedAt: now },
              }),
          );
        }),

      // Symmetric to clearModel — null the prompt, keep a sibling model.
      // Same one-tx + re-check-cleared-column shape (audit D10).
      clearSystemPrompt: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const where = and(
            eq(tenantAgentOverrides.tenantId, tenantId),
            eq(tenantAgentOverrides.agentId, agentId),
          );
          yield* wrap(
            db.transaction(async (tx) => {
              await tx
                .update(tenantAgentOverrides)
                .set({ systemPrompt: null, updatedAt: new Date() })
                .where(where);
              await tx
                .delete(tenantAgentOverrides)
                .where(
                  and(
                    where,
                    isNull(tenantAgentOverrides.model),
                    isNull(tenantAgentOverrides.systemPrompt),
                    isNull(tenantAgentOverrides.toolPermissions),
                  ),
                );
            }),
          );
        }),

      // Merge one tool's permission into the jsonb map without a read-modify-
      // write round trip: Postgres `||` shallow-merges the patch into the
      // existing map (or `{}` when the row/column is absent). Mirrors the
      // refund-policy merge in tenant-repository-live.
      setToolPermission: (
        tenantId: TenantId,
        agentId: AgentId,
        toolName: string,
        permission: Permission,
      ) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const now = new Date();
          const patch: Record<string, Permission> = { [toolName]: permission };
          const patchJson = JSON.stringify(patch);
          yield* wrap(
            db
              .insert(tenantAgentOverrides)
              .values({ tenantId, agentId, toolPermissions: patch, updatedAt: now })
              .onConflictDoUpdate({
                target: [
                  tenantAgentOverrides.tenantId,
                  tenantAgentOverrides.agentId,
                ],
                set: {
                  toolPermissions: sql`coalesce(${tenantAgentOverrides.toolPermissions}, '{}'::jsonb) || ${patchJson}::jsonb`,
                  updatedAt: now,
                },
              }),
          );
        }),

      // Drop one key from the map. `nullif(… - key, '{}')` collapses an emptied
      // map back to NULL so the field-aware row delete (below) can fire when
      // model + systemPrompt are also null. One tx like the clears above —
      // the two-statement variant has the same D10 race window.
      clearToolPermission: (
        tenantId: TenantId,
        agentId: AgentId,
        toolName: string,
      ) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const where = and(
            eq(tenantAgentOverrides.tenantId, tenantId),
            eq(tenantAgentOverrides.agentId, agentId),
          );
          yield* wrap(
            db.transaction(async (tx) => {
              await tx
                .update(tenantAgentOverrides)
                .set({
                  toolPermissions: sql`nullif(coalesce(${tenantAgentOverrides.toolPermissions}, '{}'::jsonb) - ${toolName}, '{}'::jsonb)`,
                  updatedAt: new Date(),
                })
                .where(where);
              await tx
                .delete(tenantAgentOverrides)
                .where(
                  and(
                    where,
                    isNull(tenantAgentOverrides.model),
                    isNull(tenantAgentOverrides.systemPrompt),
                    isNull(tenantAgentOverrides.toolPermissions),
                  ),
                );
            }),
          );
        }),
    });
  }),
);
