import { randomUUID } from "node:crypto";
import { Effect, FiberRef, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import {
  CustomAgentNotFound,
  CustomAgentService,
  CUSTOM_AGENT_ID_PREFIX,
  type CustomAgentInput,
  type CustomAgentRecord,
} from "@support-agent/services";
import {
  AgentId as makeAgentId,
  ConnectorStoreDbError,
  type AgentId,
  type TenantId,
} from "@support-agent/agent-core";
import { CurrentTxRef, DbClient } from "./db-client.js";
import type { DrizzleDb } from "./client.js";
import { tenantCustomAgents, type TenantCustomAgentRow } from "./schema.js";

const useDb = (defaultDb: DrizzleDb): Effect.Effect<DrizzleDb> =>
  FiberRef.get(CurrentTxRef).pipe(Effect.map((tx) => tx ?? defaultDb));

const wrap = <A>(
  promise: Promise<A>,
): Effect.Effect<A, ConnectorStoreDbError> =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new ConnectorStoreDbError({ cause }),
  });

const rowToRecord = (r: TenantCustomAgentRow): CustomAgentRecord => ({
  agentId: makeAgentId(r.agentId),
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  model: r.model,
  tools: r.tools,
  handoffs: r.handoffs.map(makeAgentId),
  callableFrom: r.callableFrom.map(makeAgentId),
  permissionOverrides: r.permissionOverrides,
  whenToUse: r.whenToUse,
  maxTurnsPerTick: r.maxTurnsPerTick,
  status: r.status as CustomAgentRecord["status"],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// The editable columns a create/update writes. Handoff/callableFrom ids are
// stored as plain strings (the record exposes them as branded AgentIds).
const editableColumns = (input: CustomAgentInput) => ({
  name: input.name,
  description: input.description,
  instructions: input.instructions,
  model: input.model,
  tools: [...input.tools],
  handoffs: [...input.handoffs],
  callableFrom: [...input.callableFrom],
  permissionOverrides: input.permissionOverrides,
  whenToUse: input.whenToUse,
  maxTurnsPerTick: input.maxTurnsPerTick,
  status: input.status,
});

export const CustomAgentServiceLive = Layer.effect(
  CustomAgentService,
  Effect.gen(function* () {
    const defaultDb = yield* DbClient;

    return CustomAgentService.of({
      tryResolve: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantCustomAgents)
              .where(
                and(
                  eq(tenantCustomAgents.tenantId, tenantId),
                  eq(tenantCustomAgents.agentId, agentId),
                  eq(tenantCustomAgents.status, "active"),
                ),
              ),
          );
          return rows[0] ? rowToRecord(rows[0]) : null;
        }),

      listForTenant: (tenantId: TenantId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantCustomAgents)
              .where(
                and(
                  eq(tenantCustomAgents.tenantId, tenantId),
                  eq(tenantCustomAgents.status, "active"),
                ),
              ),
          );
          return rows.map(rowToRecord);
        }),

      get: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .select()
              .from(tenantCustomAgents)
              .where(
                and(
                  eq(tenantCustomAgents.tenantId, tenantId),
                  eq(tenantCustomAgents.agentId, agentId),
                ),
              ),
          );
          return rows[0] ? rowToRecord(rows[0]) : null;
        }),

      create: (tenantId: TenantId, input: CustomAgentInput) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const agentId = `${CUSTOM_AGENT_ID_PREFIX}${randomUUID()}`;
          const rows = yield* wrap(
            db
              .insert(tenantCustomAgents)
              .values({ tenantId, agentId, ...editableColumns(input) })
              .returning(),
          );
          return rowToRecord(rows[0]!);
        }),

      update: (tenantId: TenantId, agentId: AgentId, input: CustomAgentInput) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          const rows = yield* wrap(
            db
              .update(tenantCustomAgents)
              .set({ ...editableColumns(input), updatedAt: new Date() })
              .where(
                and(
                  eq(tenantCustomAgents.tenantId, tenantId),
                  eq(tenantCustomAgents.agentId, agentId),
                ),
              )
              .returning(),
          );
          if (!rows[0]) {
            return yield* Effect.fail(
              new CustomAgentNotFound({ tenantId, agentId }),
            );
          }
          return rowToRecord(rows[0]);
        }),

      delete: (tenantId: TenantId, agentId: AgentId) =>
        Effect.gen(function* () {
          const db = yield* useDb(defaultDb);
          yield* wrap(
            db
              .delete(tenantCustomAgents)
              .where(
                and(
                  eq(tenantCustomAgents.tenantId, tenantId),
                  eq(tenantCustomAgents.agentId, agentId),
                ),
              ),
          );
        }),
    });
  }),
);
