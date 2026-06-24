import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConnectorCredentialStore,
  CustomAgentService,
  validateCustomAgentInput,
  type CustomAgentInput,
  type CustomAgentRecord,
  type CustomAgentValidationContext,
} from "@support-agent/services";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS, ASSIGNABLE_TOOL_NAMES } from "@support-agent/tools";
import {
  AgentId,
  TenantId,
  type Permission,
  type ToolConnectorScopeRequirement,
} from "@support-agent/agent-core";
import type {
  CustomAgentStatus,
  CustomAgentView,
} from "@support-agent/dashboard-contracts";
import { authenticateDashboard } from "../../auth/dashboard-context.js";
import { sendJson, parseJsonBody } from "../../platform/http.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";

// Connector-scope requirements by tool name, computed once (static).
const TOOL_SCOPE_REQS: ReadonlyMap<string, ToolConnectorScopeRequirement> =
  new Map(
    ALL_TOOLS.flatMap((t) =>
      t.requiredConnectorScopes
        ? ([[t.name, t.requiredConnectorScopes]] as const)
        : [],
    ),
  );

const BUILTIN_AGENT_IDS: ReadonlyArray<string> = ALL_AGENTS.map((a) => a.id);

const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 20;
const MAX_TURNS_DEFAULT = 6;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asStringArray = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const asPermissionMap = (v: unknown): Readonly<Record<string, Permission>> => {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, Permission> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === "ask" || val === "allow" || val === "deny") out[k] = val;
  }
  return out;
};
const asMaxTurns = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return MAX_TURNS_DEFAULT;
  return Math.min(MAX_TURNS_MAX, Math.max(MAX_TURNS_MIN, Math.trunc(v)));
};

const parseWriteBody = (body: Record<string, unknown>): CustomAgentInput => ({
  name: asString(body["name"]).trim(),
  description: asString(body["description"]).trim(),
  // Keep raw (only outer trim) so the merchant's formatting survives.
  instructions: asString(body["instructions"]),
  model: asString(body["model"]).trim(),
  tools: asStringArray(body["tools"]),
  handoffs: asStringArray(body["handoffs"]),
  callableFrom: asStringArray(body["callableFrom"]),
  permissionOverrides: asPermissionMap(body["permissionOverrides"]),
  whenToUse:
    typeof body["whenToUse"] === "string" && body["whenToUse"].trim()
      ? body["whenToUse"].trim()
      : null,
  maxTurnsPerTick: asMaxTurns(body["maxTurnsPerTick"]),
  status:
    typeof body["status"] === "string"
      ? (body["status"] as CustomAgentStatus)
      : "active",
});

const toView = (r: CustomAgentRecord): CustomAgentView => ({
  agentId: r.agentId,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  model: r.model,
  tools: r.tools,
  handoffs: r.handoffs,
  callableFrom: r.callableFrom,
  permissionOverrides: r.permissionOverrides,
  whenToUse: r.whenToUse,
  maxTurnsPerTick: r.maxTurnsPerTick,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

// Assemble the validation context (active connector scopes + known agent ids)
// inside an Effect, then validate + persist in the same scope.
const buildContext = (
  connections: ReadonlyArray<{
    readonly provider: string;
    readonly status: string;
    readonly scopes: ReadonlyArray<string>;
  }>,
  customs: ReadonlyArray<CustomAgentRecord>,
  selfAgentId: string | null,
): CustomAgentValidationContext => {
  const grantedScopesByProvider = new Map<string, ReadonlyArray<string>>();
  for (const c of connections) {
    if (c.status === "active") grantedScopesByProvider.set(c.provider, c.scopes);
  }
  const knownAgentIds = new Set<string>(BUILTIN_AGENT_IDS);
  for (const c of customs) knownAgentIds.add(c.agentId);
  return {
    assignableToolNames: ASSIGNABLE_TOOL_NAMES,
    knownAgentIds,
    selfAgentId,
    grantedScopesByProvider,
    toolScopeReqs: TOOL_SCOPE_REQS,
  };
};

// POST /dashboard/custom-agents — create a merchant-authored agent.
export const handleDashboardCustomAgentCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tenantId = TenantId(auth.tenantId);
  const input = parseWriteBody(parseJsonBody(req));

  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const conn = yield* ConnectorCredentialStore;
        const svc = yield* CustomAgentService;
        const connections = yield* conn
          .listForTenant(tenantId)
          .pipe(Effect.catchAll(() => Effect.succeed([])));
        const customs = yield* svc
          .listForTenant(tenantId)
          .pipe(Effect.catchAll(() => Effect.succeed([])));
        const verdict = validateCustomAgentInput(
          input,
          buildContext(connections, customs, null),
        );
        if (!verdict.ok) return { kind: "invalid", verdict } as const;
        const created = yield* svc.create(tenantId, input).pipe(Effect.either);
        if (created._tag === "Left") {
          return created.left._tag === "DuplicateCustomAgentName"
            ? ({ kind: "duplicate" } as const)
            : ({ kind: "db_error" } as const);
        }
        return { kind: "ok", record: created.right } as const;
      }),
      layer,
    ),
  );

  if (outcome.kind === "invalid") {
    return sendJson(res, 400, {
      error: outcome.verdict.error,
      ...(outcome.verdict.detail !== undefined
        ? { detail: outcome.verdict.detail }
        : {}),
    });
  }
  if (outcome.kind === "duplicate")
    return sendJson(res, 409, { error: "duplicate_name" });
  if (outcome.kind === "db_error")
    return sendJson(res, 500, { error: "internal_error" });
  return sendJson(res, 200, toView(outcome.record));
};

// GET /dashboard/custom-agents/:id — the editable view (raw instructions).
export const handleDashboardCustomAgentGet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const record = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc
          .get(TenantId(auth.tenantId), AgentId(id))
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
      }),
      layer,
    ),
  );
  if (!record) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, toView(record));
};

// POST /dashboard/custom-agents/:id — replace a custom agent's editable fields.
export const handleDashboardCustomAgentUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tenantId = TenantId(auth.tenantId);
  const { id } = req.params as { id: string };
  const input = parseWriteBody(parseJsonBody(req));

  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const conn = yield* ConnectorCredentialStore;
        const svc = yield* CustomAgentService;
        const connections = yield* conn
          .listForTenant(tenantId)
          .pipe(Effect.catchAll(() => Effect.succeed([])));
        const customs = yield* svc
          .listForTenant(tenantId)
          .pipe(Effect.catchAll(() => Effect.succeed([])));
        const verdict = validateCustomAgentInput(
          input,
          buildContext(connections, customs, id),
        );
        if (!verdict.ok) return { kind: "invalid", verdict } as const;
        const updated = yield* svc
          .update(tenantId, AgentId(id), input)
          .pipe(Effect.either);
        if (updated._tag === "Left") {
          if (updated.left._tag === "CustomAgentNotFound")
            return { kind: "not_found" } as const;
          if (updated.left._tag === "DuplicateCustomAgentName")
            return { kind: "duplicate" } as const;
          return { kind: "db_error" } as const;
        }
        return { kind: "ok", record: updated.right } as const;
      }),
      layer,
    ),
  );

  if (outcome.kind === "invalid") {
    return sendJson(res, 400, {
      error: outcome.verdict.error,
      ...(outcome.verdict.detail !== undefined
        ? { detail: outcome.verdict.detail }
        : {}),
    });
  }
  if (outcome.kind === "not_found")
    return sendJson(res, 404, { error: "not_found" });
  if (outcome.kind === "duplicate")
    return sendJson(res, 409, { error: "duplicate_name" });
  if (outcome.kind === "db_error")
    return sendJson(res, 500, { error: "internal_error" });
  return sendJson(res, 200, toView(outcome.record));
};

// POST /dashboard/custom-agents/:id/delete — remove a custom agent.
export const handleDashboardCustomAgentDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        yield* svc.delete(TenantId(auth.tenantId), AgentId(id));
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};
