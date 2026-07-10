import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  BLOCKED_SENDERS_MAX,
  CustomAgentService,
  decodeResolutionPolicyUpdate,
  defaultBlockedSenders,
  decodeShippingProfile,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  defaultResolutionPolicy,
  legalAcceptanceIsCurrent,
  normalizeBlockedSenderInput,
  TenantAgentOverridesService,
  TenantRepository,
  type BlockedSenderEntry,
  type BlockedSenders,
  type ShippingProfile,
  type LegalAcceptance,
  type ScenarioPolicy,
} from "@support-agent/services";
import { AgentId, TenantId } from "@support-agent/agent-core";
import { ALL_AGENTS } from "@support-agent/agents";
import { ALL_TOOLS } from "@support-agent/tools";
import {
  createTenantForOrg,
  createWorkspaceForOrg,
  findWorkspaceForOrg,
  listWorkspacesByWorkosOrg,
  renameWorkspaceForOrg,
  tenantByWorkosOrg,
} from "@support-agent/db";
import { fetchModelCatalog } from "@support-agent/providers";
import { isWorkspaceIdShape } from "../../auth/dashboard-auth.js";
import { buildCatalogResponse } from "./catalog.js";
import {
  buildModelsResponse,
  resolveActiveLlmCredential,
  resolveLlmCredentialStatus,
} from "./llm.js";
import { resolveShopCurrencyCode } from "./shopify-panels.js";
import {
  deleteResultStatus,
  deleteTenantAccount,
} from "../admin/account-handlers.js";
import {
  authenticateDashboard,
  authenticateDashboardOrg,
  makeLegalAcceptance,
  runWithDb,
  sendLegalAcceptanceRequired,
} from "../../auth/dashboard-context.js";
import { sendJson, parseJsonBody } from "../../platform/http.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";

// GET /dashboard/catalog — built-in + custom agent inventory + the tool
// catalog (settings pages). Workspace-scoped (NOT org-scoped) because custom
// agents are per-workspace; the merchant's custom agents are unioned with the
// built-ins. A custom-store read failure degrades to built-ins only.
export const handleDashboardCatalog = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const customs = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* CustomAgentService;
        return yield* svc
          .listForTenant(TenantId(auth.tenantId))
          .pipe(Effect.catchAll(() => Effect.succeed([])));
      }),
      layer,
    ),
  );
  return sendJson(
    res,
    200,
    buildCatalogResponse(ALL_AGENTS, ALL_TOOLS, customs),
  );
};

// GET /dashboard/models — the tenant's LLM model catalog. The decrypted key
// is resolved + used server-side; only the model list reaches the client.
export const handleDashboardModels = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  // The configured "Rephrase with AI" model is a stored tenant setting, so it
  // travels in the models response regardless of the connection state.
  const rephraseModel = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo
          .getSettings(TenantId(auth.tenantId))
          .pipe(Effect.either);
        return settings._tag === "Right"
          ? (settings.right.rephraseModel ?? null)
          : null;
      }),
      layer,
    ),
  );
  const cred = await Effect.runPromise(
    Effect.provide(resolveActiveLlmCredential(auth.tenantId), layer),
  );
  if (!cred) {
    return sendJson(res, 200, buildModelsResponse(null, null, rephraseModel));
  }
  const catalog = await fetchModelCatalog({
    provider: cred.provider,
    apiKey: cred.apiKey,
    ...(cred.baseURL !== undefined ? { baseURL: cred.baseURL } : {}),
  });
  return sendJson(res, 200, buildModelsResponse(cred, catalog, rephraseModel));
};

// POST /dashboard/settings/rephrase-model — set (or clear) the workspace model
// used by the "Rephrase with AI" composer action. A blank/whitespace body
// clears it so the rephrase handler reverts to its built-in default.
export const handleDashboardRephraseModelSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setRephraseModel(
          TenantId(auth.tenantId),
          model.length > 0 ? model : null,
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

export const handleDashboardLlmStatus = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const status = await Effect.runPromise(
    Effect.provide(resolveLlmCredentialStatus(auth.tenantId), layer),
  );
  return sendJson(res, 200, status);
};

// GET /dashboard/tenant — the org's tenant (or null → dashboard sends to
// onboarding). Token + org auth; does NOT require an existing tenant.
export const handleDashboardTenant = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const tenant = await runWithDb(layer, (db) =>
    tenantByWorkosOrg(db, auth.organizationId),
  );
  return sendJson(res, 200, {
    tenant: tenant ? { tenantId: tenant.id, name: tenant.name } : null,
  });
};

// GET /dashboard/workspaces — every workspace (tenant row) the org owns,
// default first. Org-auth on purpose: the switcher must render (empty) for
// an org that hasn't onboarded its first workspace yet, and the dashboard's
// context gate maps the empty list to /onboarding itself.
export const handleDashboardWorkspaces = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  return sendJson(res, 200, {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      shopifyDomain: w.shopifyDomain,
    })),
    defaultWorkspaceId: workspaces[0]?.id ?? null,
  });
};

// POST /dashboard/workspaces — mint an ADDITIONAL workspace under the org.
// The org's current legal acceptance is copied verbatim onto the new row
// (who/when preserved): the connector gates hard-require a current
// acceptance per tenant row, so a workspace minted without one could never
// connect anything. No current acceptance anywhere → the manager re-accepts
// first (403, same signal the legal page already handles). Zero workspaces →
// onboarding owns first-workspace creation (409).
export const handleDashboardWorkspaceCreate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const email =
    typeof body["notificationEmail"] === "string"
      ? body["notificationEmail"].trim()
      : "";
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  if (!email.includes("@")) return sendJson(res, 400, { error: "bad_email" });

  const workspaces = await runWithDb(layer, (db) =>
    listWorkspacesByWorkosOrg(db, auth.organizationId),
  );
  if (workspaces.length === 0) {
    return sendJson(res, 409, { error: "use_onboarding" });
  }
  // First current acceptance among the org's workspaces (default first) —
  // scanning all avoids a dead end when only a newer workspace re-accepted.
  let acceptance: LegalAcceptance | null = null;
  for (const ws of workspaces) {
    const candidate = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          const settings = yield* repo.getSettings(TenantId(ws.id));
          return settings.legalAcceptance;
        }).pipe(Effect.catchAll(() => Effect.succeed(null))),
        layer,
      ),
    );
    if (legalAcceptanceIsCurrent(candidate)) {
      acceptance = candidate;
      break;
    }
  }
  if (!acceptance) return sendLegalAcceptanceRequired(res);

  const result = await runWithDb(layer, (db) =>
    createWorkspaceForOrg(db, {
      organizationId: auth.organizationId,
      name: name.slice(0, 120),
      notificationEmail: email.slice(0, 254),
      legalAcceptance: acceptance,
    }),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/workspaces/:id/rename — names are load-bearing (delete
// confirmations match on them), so renames go through the same org-ownership
// check as everything else. Foreign/unknown → 404, like the auth path.
export const handleDashboardWorkspaceRename = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!isWorkspaceIdShape(id)) {
    return sendJson(res, 400, { error: "invalid_workspace_id" });
  }
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  const renamed = await runWithDb(layer, (db) =>
    renameWorkspaceForOrg(db, {
      organizationId: auth.organizationId,
      workspaceId: id,
      name: name.slice(0, 120),
    }),
  );
  if (!renamed) return sendJson(res, 404, { error: "workspace_not_found" });
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/workspaces/:id/delete — wipe ONE workspace. The WorkOS
// org and sibling workspaces survive (allowOrgDelete: false), and no
// deletion email goes out. The LAST workspace is refused — deleting it is
// account deletion, which has its own flow and confirmation.
export const handleDashboardWorkspaceDelete = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!isWorkspaceIdShape(id)) {
    return sendJson(res, 400, { error: "invalid_workspace_id" });
  }
  const owned = await runWithDb(layer, (db) =>
    findWorkspaceForOrg(db, auth.organizationId, id),
  );
  if (!owned) return sendJson(res, 404, { error: "workspace_not_found" });
  const count = (
    await runWithDb(layer, (db) =>
      listWorkspacesByWorkosOrg(db, auth.organizationId),
    )
  ).length;
  if (count <= 1) return sendJson(res, 409, { error: "last_workspace" });
  const result = await deleteTenantAccount(cfg, layer, id, "tenant_self", {
    allowOrgDelete: false,
    sendEmail: false,
  });
  return sendJson(res, deleteResultStatus(result), result);
};

// GET /dashboard/shop-currency — best-effort store currency (ISO 4217) for
// the refund-policy page's currency-mismatch warning. Null when there's no
// live Shopify connection or the lookup fails; the page just omits the hint.
export const handleDashboardShopCurrency = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const currencyCode = await Effect.runPromise(
    Effect.provide(resolveShopCurrencyCode(TenantId(auth.tenantId)), layer),
  );
  return sendJson(res, 200, { currencyCode });
};

// GET /dashboard/settings — resolved tenant settings (refund policy +
// supplier-escalation sheet + notification email). Defaults are applied by
// getSettings; a transient error falls back to platform defaults.
export const handleDashboardSettings = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const settings = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        return yield* repo.getSettings(TenantId(auth.tenantId));
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            notificationEmail: null,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            supplierEscalationSheet: null,
            legalAcceptance: null,
            cancellationRestock: true,
            shippingProfile: null,
          } as const),
        ),
      ),
      layer,
    ),
  );
  return sendJson(res, 200, {
    notificationEmail: settings.notificationEmail,
    refundPolicy: settings.refundPolicy,
    discountPolicy: settings.discountPolicy,
    supplierEscalationSheet: settings.supplierEscalationSheet,
    legalAcceptance: settings.legalAcceptance,
    // Restock-on-cancel flag for the refund-policy page's "Order
    // cancellations" checkbox. Defaults-on-read in getSettings ⇒ true.
    cancellationRestock: settings.cancellationRestock !== false,
    // Null until the merchant fills the Knowledge base page's shipping form.
    shippingProfile: settings.shippingProfile ?? null,
  });
};

// ---- Resolution policy (scenario agent) ----

const scenarioToView = (s: ScenarioPolicy) => ({
  key: s.key,
  label: s.label,
  recognition: s.recognition ?? null,
  builtin: s.builtin,
  enabled: s.enabled !== false,
  enabledActions: s.enabledActions.map((a) => ({
    tool: a.tool,
    permission: a.permission,
  })),
  supplierMode: s.supplierMode,
  notes: s.notes ?? null,
});

// GET /dashboard/resolution-policy — the flag + the scenario cards (defaults-on-read).
export const handleDashboardResolutionPolicy = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { enabled, scenarios } = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(auth.tenantId));
        const policy = settings.resolutionPolicy ?? defaultResolutionPolicy;
        return {
          enabled: settings.resolutionAgentEnabled === true,
          scenarios: policy.scenarios,
        };
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({
            enabled: false,
            scenarios: defaultResolutionPolicy.scenarios,
          }),
        ),
      ),
      layer,
    ),
  );
  return sendJson(res, 200, {
    resolutionAgentEnabled: enabled,
    scenarios: scenarios.map(scenarioToView),
  });
};

// POST /dashboard/resolution-policy — save the scenario cards (built-in edits
// + merchant-authored custom scenarios). The body's `scenarios` go through
// `decodeResolutionPolicyUpdate`, the server-side authority: built-in immutable
// fields are forced from the seeded defaults (a merchant can't rename or delete
// one), and custom scenarios get `builtin:false` + a stable, namespaced key.
// The result is the same shape the runtime reads, so the agent can't choke.
export const handleDashboardSetResolutionPolicy = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const policy = decodeResolutionPolicyUpdate({ scenarios: body["scenarios"] });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setResolutionPolicy(TenantId(auth.tenantId), policy);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/resolution-agent — toggle whether triage routes to the
// scenario agent for this tenant.
export const handleDashboardSetResolutionAgentEnabled = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const enabled = body["enabled"] === true;
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setResolutionAgentEnabled(TenantId(auth.tenantId), enabled);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true, enabled });
};

// POST /dashboard/onboarding — create a tenant for the asserted org.
export const handleDashboardOnboarding = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboardOrg(cfg, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  const email =
    typeof body["notificationEmail"] === "string"
      ? body["notificationEmail"].trim()
      : "";
  const legalAccepted = body["legalAccepted"] === true;
  if (name.length < 2) return sendJson(res, 400, { error: "bad_name" });
  if (!email.includes("@")) return sendJson(res, 400, { error: "bad_email" });
  if (!legalAccepted) {
    return sendJson(res, 400, { error: "legal_acceptance_required" });
  }
  const result = await runWithDb(layer, (db) =>
    createTenantForOrg(db, {
      organizationId: auth.organizationId,
      name: name.slice(0, 120),
      notificationEmail: email.slice(0, 254),
      legalAcceptance: makeLegalAcceptance(auth.userId),
    }),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/legal-acceptance — accept the current legal notice + DPA
// for an existing tenant (used by tenants created before the gate shipped).
export const handleDashboardLegalAcceptance = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setLegalAcceptance(
          TenantId(auth.tenantId),
          makeLegalAcceptance(auth.userId),
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/model — set a per-agent model override.
export const handleDashboardAgentModelSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  const body = parseJsonBody(req);
  const model = typeof body["model"] === "string" ? body["model"].trim() : "";
  if (!model) return sendJson(res, 400, { error: "missing_model" });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.setModel(TenantId(auth.tenantId), AgentId(id), model);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/model/clear — drop the override (→ config default).
export const handleDashboardAgentModelClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearModel(TenantId(auth.tenantId), AgentId(id));
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/system-prompt — set the tenant's custom prompt
// (appended to the agent's built-in prompt). A blank body clears it, so the
// dashboard can "save empty" to revert without a separate request.
export const handleDashboardAgentSystemPromptSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  const body = parseJsonBody(req);
  const systemPrompt =
    typeof body["systemPrompt"] === "string" ? body["systemPrompt"].trim() : "";
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        if (systemPrompt) {
          yield* svc.setSystemPrompt(
            TenantId(auth.tenantId),
            AgentId(id),
            systemPrompt,
          );
        } else {
          yield* svc.clearSystemPrompt(TenantId(auth.tenantId), AgentId(id));
        }
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/system-prompt/clear — drop the custom prompt
// (→ bare AgentConfig prompt). Keeps any model override on the same row.
export const handleDashboardAgentSystemPromptClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  if (!ALL_AGENTS.some((a) => a.id === id)) {
    return sendJson(res, 404, { error: "unknown_agent" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearSystemPrompt(TenantId(auth.tenantId), AgentId(id));
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// Resolve a tenant-configurable tool for an agent, or an error code. Guards the
// tool-permission endpoints: the tool must be bound to the agent AND carry the
// `permission-toggle` control (so `refund.create`, governed by the refund-policy
// page, and internal plumbing tools are both rejected here).
export const resolveConfigurableTool = (
  agentId: string,
  toolName: unknown,
):
  | { ok: true; tool: string }
  | { ok: false; status: number; error: string } => {
  const agent = ALL_AGENTS.find((a) => a.id === agentId);
  if (!agent) return { ok: false, status: 404, error: "unknown_agent" };
  if (typeof toolName !== "string" || toolName.length === 0) {
    return { ok: false, status: 400, error: "missing_tool" };
  }
  if (!agent.tools.includes(toolName)) {
    return { ok: false, status: 400, error: "tool_not_on_agent" };
  }
  const tool = ALL_TOOLS.find((t) => t.name === toolName);
  if (!tool || tool.tenantControl !== "permission-toggle") {
    return { ok: false, status: 400, error: "tool_not_configurable" };
  }
  return { ok: true, tool: toolName };
};

// POST /dashboard/agents/:id/tool-permission — set a per-agent "ask first" vs
// "auto" choice for one tool. Body: { tool, permission } where permission is
// "ask" | "allow" (tenants can never set "deny" here — that stays a policy
// outcome). The runtime overlays this onto the agent's permissionOverrides.
export const handleDashboardAgentToolPermissionSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const resolved = resolveConfigurableTool(id, body["tool"]);
  if (!resolved.ok) {
    return sendJson(res, resolved.status, { error: resolved.error });
  }
  const permission = body["permission"];
  if (permission !== "ask" && permission !== "allow") {
    return sendJson(res, 400, { error: "invalid_permission" });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.setToolPermission(
          TenantId(auth.tenantId),
          AgentId(id),
          resolved.tool,
          permission,
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// POST /dashboard/agents/:id/tool-permission/clear — drop the per-agent override
// for one tool (revert to the agent default). Body: { tool }.
export const handleDashboardAgentToolPermissionClear = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const resolved = resolveConfigurableTool(id, body["tool"]);
  if (!resolved.ok) {
    return sendJson(res, resolved.status, { error: resolved.error });
  }
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const svc = yield* TenantAgentOverridesService;
        yield* svc.clearToolPermission(
          TenantId(auth.tenantId),
          AgentId(id),
          resolved.tool,
        );
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};

// ---- Shipping profile ----

export type ShippingProfileInput =
  | { readonly ok: true; readonly profile: ShippingProfile }
  | { readonly ok: false; readonly error: string };

/**
 * Validate the shipping-profile form body. The three starred fields are
 * required and each gets its own error code so the form can point at the field
 * that failed; the optional ones degrade to `null` rather than rejecting the
 * save (a stale customs enum from an old tab shouldn't cost the merchant their
 * typing). Normalization — trim, cap, clamp — is delegated to
 * `decodeShippingProfile`, the same decoder the agent runtime reads through, so
 * what we persist is exactly what an agent will later see.
 *
 * Pure + exported for its own unit test.
 */
export const parseShippingProfileInput = (
  body: Record<string, unknown>,
): ShippingProfileInput => {
  const processingTime = body["processingTime"];
  if (typeof processingTime !== "string" || processingTime.trim() === "") {
    return { ok: false, error: "invalid_processing_time" };
  }
  const deliveryTime = body["deliveryTime"];
  if (typeof deliveryTime !== "string" || deliveryTime.trim() === "") {
    return { ok: false, error: "invalid_delivery_time" };
  }

  // A number input round-trips as text through some clients, so accept both.
  const rawDays = body["delayedAfterDays"];
  const days =
    typeof rawDays === "number"
      ? rawDays
      : typeof rawDays === "string" && rawDays.trim() !== ""
        ? Number(rawDays)
        : Number.NaN;
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, error: "invalid_delay_days" };
  }

  const profile = decodeShippingProfile({
    processingTime,
    deliveryTime,
    shippingCost: body["shippingCost"],
    customsDuties: body["customsDuties"],
    delayedAfterDays: days,
  });
  // Unreachable given the guards above; a null here would mean the decoder and
  // this validator disagree, which must not silently persist a broken profile.
  if (!profile) return { ok: false, error: "invalid_profile" };
  return { ok: true, profile };
};

// POST /dashboard/shipping-profile — replace the store's shipping profile.
// Its own permission-gated endpoint; the profile is READ back through
// /dashboard/settings alongside the other store policies.
export const handleDashboardShippingProfileSet = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const parsed = parseShippingProfileInput(parseJsonBody(req));
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setShippingProfile(TenantId(auth.tenantId), parsed.profile);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true, shippingProfile: parsed.profile });
};

// ---- Blocked senders ----

const currentBlockedSenders = (
  layer: ApiLayer,
  tenantId: string,
): Promise<BlockedSenders> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(tenantId));
        return settings.blockedSenders ?? defaultBlockedSenders;
      }).pipe(
        Effect.catchAll(() => Effect.succeed(defaultBlockedSenders)),
      ),
      layer,
    ),
  );

/**
 * Append one normalized entry to the tenant's blocklist. Shared by the
 * settings add endpoint and the ticket-page "Block sender" action so the
 * dedupe/cap rules live in exactly one place. Returns the HTTP outcome.
 */
export const addBlockedSenderEntry = async (
  layer: ApiLayer,
  tenantId: string,
  entry: BlockedSenderEntry,
): Promise<
  | { readonly kind: "added" | "already_blocked" }
  | { readonly kind: "list_full" }
> => {
  const current = await currentBlockedSenders(layer, tenantId);
  const list = entry.kind === "email" ? current.emails : current.domains;
  if (list.includes(entry.value)) return { kind: "already_blocked" };
  if (list.length >= BLOCKED_SENDERS_MAX) return { kind: "list_full" };
  const next: BlockedSenders =
    entry.kind === "email"
      ? { ...current, emails: [...current.emails, entry.value] }
      : { ...current, domains: [...current.domains, entry.value] };
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setBlockedSenders(TenantId(tenantId), next);
      }),
      layer,
    ),
  );
  return { kind: "added" };
};

// GET /dashboard/blocked-senders — the tenant's sender blocklist. Its own
// permission-gated endpoint, deliberately NOT part of /dashboard/settings
// (which any signed-in member may read).
export const handleDashboardBlockedSenders = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const blocked = await currentBlockedSenders(layer, auth.tenantId);
  return sendJson(res, 200, {
    emails: blocked.emails,
    domains: blocked.domains,
  });
};

// POST /dashboard/blocked-senders/add — add one entry. The value is
// classified server-side: contains "@" with a local part → email entry
// (blocks one address); bare or "@"-prefixed domain → domain entry (blocks
// the domain and all its subdomains).
export const handleDashboardBlockedSendersAdd = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const value = typeof body["value"] === "string" ? body["value"] : "";
  const entry = normalizeBlockedSenderInput(value);
  if (!entry) return sendJson(res, 400, { error: "bad_value" });
  const outcome = await addBlockedSenderEntry(layer, auth.tenantId, entry);
  if (outcome.kind === "list_full") {
    return sendJson(res, 400, { error: "list_full" });
  }
  return sendJson(res, 200, {
    ok: true,
    entry,
    ...(outcome.kind === "already_blocked" ? { alreadyBlocked: true } : {}),
  });
};

// POST /dashboard/blocked-senders/remove — delete one entry. Removing a
// value that isn't on the list is a no-op, not an error (idempotent UI).
export const handleDashboardBlockedSendersRemove = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const kind = body["kind"];
  const value =
    typeof body["value"] === "string" ? body["value"].trim().toLowerCase() : "";
  if ((kind !== "email" && kind !== "domain") || value === "") {
    return sendJson(res, 400, { error: "bad_value" });
  }
  const current = await currentBlockedSenders(layer, auth.tenantId);
  const next: BlockedSenders =
    kind === "email"
      ? { ...current, emails: current.emails.filter((e) => e !== value) }
      : { ...current, domains: current.domains.filter((d) => d !== value) };
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setBlockedSenders(TenantId(auth.tenantId), next);
      }),
      layer,
    ),
  );
  return sendJson(res, 200, { ok: true });
};
