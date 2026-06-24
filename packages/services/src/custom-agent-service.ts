import { Context, Data, Effect, Layer } from "effect";
import {
  AgentId as makeAgentId,
  type AgentId,
  type ConnectorStoreDbError,
  type Permission,
  type TenantId,
} from "@support-agent/agent-core";

// ============================================================
// Types
// ============================================================

export type CustomAgentStatus = "draft" | "active" | "disabled";

/**
 * A merchant-authored agent as stored, before the shared prompt scaffold is
 * applied. `instructions` is the RAW merchant text; the `AgentResolver`
 * composes it into an `AgentConfig.promptTemplate` at read time. `agentId`
 * always carries the reserved `custom:` prefix.
 *
 * `tools` are tool NAMES (`agent.handoff` is implicit and never stored).
 * `handoffs` / `callableFrom` are agent ids (built-in or other custom ids in
 * the same workspace). `permissionOverrides` mirrors
 * `tenant_agent_overrides.tool_permissions`.
 */
export interface CustomAgentRecord {
  readonly agentId: AgentId;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: ReadonlyArray<string>;
  readonly handoffs: ReadonlyArray<AgentId>;
  readonly callableFrom: ReadonlyArray<AgentId>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly whenToUse: string | null;
  readonly maxTurnsPerTick: number;
  readonly status: CustomAgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The editable field set a create/update accepts. The server assigns the
 * `agentId` (create) and preserves `createdAt`; everything a merchant controls
 * lives here. Validation (assignable tools, satisfiable scopes, known handoff
 * targets) happens in the API layer BEFORE these reach the service — the
 * service persists what it is given.
 */
export interface CustomAgentInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: ReadonlyArray<string>;
  readonly handoffs: ReadonlyArray<string>;
  readonly callableFrom: ReadonlyArray<string>;
  readonly permissionOverrides: Readonly<Record<string, Permission>>;
  readonly whenToUse: string | null;
  readonly maxTurnsPerTick: number;
  readonly status: CustomAgentStatus;
}

// ============================================================
// Errors
// ============================================================

export class CustomAgentNotFound extends Data.TaggedError(
  "CustomAgentNotFound",
)<{
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
}> {}

// A custom agent with this name (case-insensitive) already exists in the
// workspace — raised by the DB unique index on create/update.
export class DuplicateCustomAgentName extends Data.TaggedError(
  "DuplicateCustomAgentName",
)<{
  readonly tenantId: TenantId;
  readonly name: string;
}> {}

export type CustomAgentError =
  | CustomAgentNotFound
  | DuplicateCustomAgentName;

// The reserved id prefix that namespaces every merchant-authored agent so a
// custom id can never collide with a bare built-in id.
export const CUSTOM_AGENT_ID_PREFIX = "custom:";

export const isCustomAgentId = (id: string): boolean =>
  id.startsWith(CUSTOM_AGENT_ID_PREFIX);

// ============================================================
// Tag
// ============================================================

/**
 * Persistence + resolution for merchant-authored agents. `tryResolve` is the
 * runtime hot path (one row by id, ACTIVE only); the rest back the dashboard
 * CRUD. Tenant-scoped on every call so one workspace's agents never resolve
 * for another.
 */
export class CustomAgentService extends Context.Tag("CustomAgentService")<
  CustomAgentService,
  {
    /**
     * Resolve ONE active custom agent by id. Returns null on a real miss
     * (unknown id, wrong tenant, draft/disabled) — never throws an
     * unknown-agent error, so the resolver can fall through cleanly.
     */
    readonly tryResolve: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<CustomAgentRecord | null, ConnectorStoreDbError>;

    /** Every ACTIVE custom agent for the tenant (catalog + roster building). */
    readonly listForTenant: (
      tenantId: TenantId,
    ) => Effect.Effect<ReadonlyArray<CustomAgentRecord>, ConnectorStoreDbError>;

    /** Fetch one custom agent regardless of status (the edit form prefill). */
    readonly get: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<CustomAgentRecord | null, ConnectorStoreDbError>;

    /**
     * Insert a new custom agent; the service assigns the `custom:` id. Fails
     * `DuplicateCustomAgentName` when the name is already taken in the workspace.
     */
    readonly create: (
      tenantId: TenantId,
      input: CustomAgentInput,
    ) => Effect.Effect<
      CustomAgentRecord,
      DuplicateCustomAgentName | ConnectorStoreDbError
    >;

    /** Replace the editable fields of an existing custom agent. */
    readonly update: (
      tenantId: TenantId,
      agentId: AgentId,
      input: CustomAgentInput,
    ) => Effect.Effect<
      CustomAgentRecord,
      CustomAgentError | ConnectorStoreDbError
    >;

    /** Remove a custom agent. No-op if it does not exist. */
    readonly delete: (
      tenantId: TenantId,
      agentId: AgentId,
    ) => Effect.Effect<void, ConnectorStoreDbError>;
  }
>() {}

// ============================================================
// Test Layer — in-memory, mutable
// ============================================================

const keyStr = (tenantId: TenantId, agentId: AgentId): string =>
  `${tenantId}\x00${agentId}`;

const recordFromInput = (
  agentId: AgentId,
  input: CustomAgentInput,
  createdAt: Date,
  updatedAt: Date,
): CustomAgentRecord => ({
  agentId,
  name: input.name,
  description: input.description,
  instructions: input.instructions,
  model: input.model,
  tools: input.tools,
  handoffs: input.handoffs.map(makeAgentId),
  callableFrom: input.callableFrom.map(makeAgentId),
  permissionOverrides: input.permissionOverrides,
  whenToUse: input.whenToUse,
  maxTurnsPerTick: input.maxTurnsPerTick,
  status: input.status,
  createdAt,
  updatedAt,
});

export const CustomAgentServiceTest = (
  seed: ReadonlyArray<{
    readonly tenantId: TenantId;
    readonly record: CustomAgentRecord;
  }> = [],
) =>
  Layer.sync(CustomAgentService, () => {
    const store = new Map<
      string,
      { tenantId: TenantId; record: CustomAgentRecord }
    >();
    for (const row of seed) {
      store.set(keyStr(row.tenantId, row.record.agentId), {
        tenantId: row.tenantId,
        record: row.record,
      });
    }
    let counter = 0;

    // Case-insensitive name collision within a tenant, ignoring `exceptId`
    // (the row being updated). Mirrors the DB unique index.
    const nameTaken = (
      tenantId: TenantId,
      name: string,
      exceptId: AgentId | null,
    ): boolean => {
      const needle = name.trim().toLowerCase();
      for (const entry of store.values()) {
        if (entry.tenantId !== tenantId) continue;
        if (exceptId !== null && entry.record.agentId === exceptId) continue;
        if (entry.record.name.trim().toLowerCase() === needle) return true;
      }
      return false;
    };

    return CustomAgentService.of({
      tryResolve: (tenantId, agentId) =>
        Effect.sync(() => {
          const hit = store.get(keyStr(tenantId, agentId));
          if (!hit || hit.tenantId !== tenantId) return null;
          return hit.record.status === "active" ? hit.record : null;
        }),

      listForTenant: (tenantId) =>
        Effect.sync(() => {
          const out: CustomAgentRecord[] = [];
          for (const entry of store.values()) {
            if (entry.tenantId === tenantId && entry.record.status === "active") {
              out.push(entry.record);
            }
          }
          return out;
        }),

      get: (tenantId, agentId) =>
        Effect.sync(() => {
          const hit = store.get(keyStr(tenantId, agentId));
          return hit && hit.tenantId === tenantId ? hit.record : null;
        }),

      create: (tenantId, input) =>
        Effect.gen(function* () {
          if (nameTaken(tenantId, input.name, null)) {
            return yield* Effect.fail(
              new DuplicateCustomAgentName({ tenantId, name: input.name }),
            );
          }
          counter += 1;
          const agentId = makeAgentId(
            `${CUSTOM_AGENT_ID_PREFIX}test-${counter}`,
          );
          const now = new Date();
          const record = recordFromInput(agentId, input, now, now);
          store.set(keyStr(tenantId, agentId), { tenantId, record });
          return record;
        }),

      update: (tenantId, agentId, input) =>
        Effect.gen(function* () {
          const hit = store.get(keyStr(tenantId, agentId));
          if (!hit || hit.tenantId !== tenantId) {
            return yield* Effect.fail(
              new CustomAgentNotFound({ tenantId, agentId }),
            );
          }
          if (nameTaken(tenantId, input.name, agentId)) {
            return yield* Effect.fail(
              new DuplicateCustomAgentName({ tenantId, name: input.name }),
            );
          }
          const record = recordFromInput(
            agentId,
            input,
            hit.record.createdAt,
            new Date(),
          );
          store.set(keyStr(tenantId, agentId), { tenantId, record });
          return record;
        }),

      delete: (tenantId, agentId) =>
        Effect.sync(() => {
          store.delete(keyStr(tenantId, agentId));
        }),
    });
  });
