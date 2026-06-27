import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  applyApprovalDecision,
  AuditLogService,
  CaseRepository,
  ConnectorCredentialStore,
  ConversationService,
  decisionToEvent,
  LLMService,
  ShopifyService,
  TenantRepository,
  parseThreadId,
  namespaceThreadId,
  ShopifyAppProvisioningStore,
} from "@support-agent/services";
import {
  CaseId,
  OrderId,
  TenantId,
  ThreadId,
  UserId,
} from "@support-agent/agent-core";
import { randomUUID } from "node:crypto";
import {
  activeShopifyShopDomain,
  agentOverrides,
  approvalDetail,
  approvalsList,
  auditList,
  caseContextForTenant,
  caseDetail,
  caseEvents,
  casesList,
  connectionsList,
  DbClient,
  getActiveReplyDeliveryForCase,
  getMemberAccess,
  parsePageNumber,
  parsePageSize,
  requeueReplyDeliveryNow,
  resumeCase,
  setCaseStatus,
  takeOverCase,
  todaySummary,
  usageRows,
} from "@support-agent/db";
import { decideAuthz } from "../../auth/dashboard-authz.js";
import { retryCaseNow } from "./case-retry.js";
import {
  sendManualReply,
  type ManualReplyCaseView,
} from "./case-reply.js";
import { issueCaseRefund } from "./case-refund.js";
import {
  buildRephraseMessages,
  rephraseDraft,
  REPHRASE_SYSTEM,
} from "./rephrase.js";
import { resolveActiveLlmCredential } from "./llm.js";
import {
  conversationUnavailableReason,
  projectConversationThread,
  resolveCaseConversationThread,
} from "./conversation-thread.js";
import {
  resolveCustomerForContext,
  resolveOrderForContext,
} from "./shopify-panels.js";
import { makePgBossApprovalPublisher } from "../approvals/endpoints.js";
import { acquireApprovalBoss } from "../../platform/pgboss.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { sendJson, opaqueCause, strField, strList, parseJsonBody } from "../../platform/http.js";
import {
  runWithDb,
  authenticateDashboard,
} from "../../auth/dashboard-context.js";
import { resolveTenantShopifyApp } from "../shopify/handlers.js";

// GET /dashboard/today — Today-view rollup.
export const handleDashboardToday = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const summary = await runWithDb(layer, (db) =>
    todaySummary(db, auth.tenantId),
  );
  return sendJson(res, 200, summary);
};

// GET /dashboard/cases?q=&page=&limit= — paginated cases list, optional search.
export const handleDashboardCases = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    casesList(
      db,
      auth.tenantId,
      { q: strField(q, "q") },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id — case + timeline + approvals.
export const handleDashboardCaseDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    caseDetail(db, auth.tenantId, id),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id/conversation-thread — live provider thread for the
// third case-timeline view. The case lookup is tenant-scoped before any
// provider call, and connector failures degrade to a stable UI result.
export const handleDashboardCaseConversationThread = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const cases = yield* CaseRepository;
        const conversation = yield* ConversationService;
        const connectorStore = yield* ConnectorCredentialStore;
        const caseRow = yield* cases
          .getById(CaseId(id), TenantId(auth.tenantId))
          .pipe(Effect.catchTag("CaseNotFound", () => Effect.succeed(null)));
        if (!caseRow) return { kind: "not_found" as const };
        if (!caseRow.threadId) {
          return {
            kind: "result" as const,
            result: {
              status: "unavailable" as const,
              reason: "no_thread" as const,
            },
          };
        }
        const threadId = caseRow.threadId;
        const rawThreadId = parseThreadId(threadId)?.raw ?? threadId;
        const provider =
          parseThreadId(threadId)?.provider ??
          (yield* cases.findThreadProvider(TenantId(auth.tenantId), threadId));
        const connections = yield* connectorStore.listForTenant(
          TenantId(auth.tenantId),
        );
        const threadResult = yield* resolveCaseConversationThread(
          caseRow.mailbox,
          provider,
          connections,
          (candidateProvider, mailbox) =>
            conversation.fetchThread(
              TenantId(auth.tenantId),
              namespaceThreadId(candidateProvider, rawThreadId),
              mailbox,
            ),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({
              status: "unavailable" as const,
              reason: conversationUnavailableReason(error),
            }),
            onSuccess: (resolution) =>
              resolution.ok
                ? {
                    status: "available" as const,
                    thread: projectConversationThread(resolution.thread),
                  }
                : {
                    status: "unavailable" as const,
                    reason: resolution.reason,
                  },
          }),
        );
        return { kind: "result" as const, result: threadResult };
      }),
      layer,
    ),
  );
  if (result.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, result.result);
};

// GET /dashboard/cases/:id/events?since= — audit rows after `since` (poll).
export const handleDashboardCaseEvents = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const sinceRaw = strField((req.query ?? {}) as Record<string, unknown>, "since");
  let since = 0n;
  try {
    if (sinceRaw) since = BigInt(sinceRaw);
  } catch {
    since = 0n;
  }
  const result = await runWithDb(layer, (db) =>
    caseEvents(db, auth.tenantId, id, since),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/approvals?status=&risk=&tool=&agent=&page=&limit=
// status/risk/tool/agent are repeatable (multi-select); absent status → pending.
export const handleDashboardApprovals = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    approvalsList(
      db,
      auth.tenantId,
      {
        status: strList(q, "status"),
        risk: strList(q, "risk"),
        tool: strList(q, "tool"),
        agent: strList(q, "agent"),
      },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// GET /dashboard/approvals/:id — full approval.
export const handleDashboardApprovalDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    approvalDetail(db, auth.tenantId, id),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/cases/:id/shopify — case-detail Shopify panels (customer +
// order + active shop domain). Best-effort: Shopify failures yield nulls.
export const handleDashboardCaseShopify = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        const ctx = yield* Effect.promise(() =>
          caseContextForTenant(db, auth.tenantId, id),
        );
        if (!ctx) return { kind: "not_found" as const };
        const context = (ctx.context ?? {}) as Record<string, unknown>;
        const shopDomain = yield* Effect.promise(() =>
          activeShopifyShopDomain(db, auth.tenantId),
        );
        const order = yield* resolveOrderForContext(
          TenantId(auth.tenantId),
          context,
        );
        const customer = yield* resolveCustomerForContext(
          TenantId(auth.tenantId),
          context,
          order,
        );
        return { kind: "ok" as const, customer, order, shopDomain };
      }),
      layer,
    ),
  );
  if (result.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  return sendJson(res, 200, {
    customer: result.customer,
    order: result.order,
    shopDomain: result.shopDomain,
  });
};

// GET /dashboard/usage?start=&end= — raw llm.decision rows in a window for
// the settings/usage page (the dashboard applies pricing + aggregation).
export const handleDashboardUsage = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const parseDate = (raw: string | undefined, fallback: number): Date => {
    if (!raw) return new Date(fallback);
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  };
  // Default window: trailing ~31 days when the client omits bounds.
  const start = parseDate(strField(q, "start"), now - 31 * 86_400_000);
  const end = parseDate(strField(q, "end"), now);
  const rows = await runWithDb(layer, (db) =>
    usageRows(db, auth.tenantId, start, end),
  );
  return sendJson(res, 200, { rows });
};

// GET /dashboard/agent-overrides — per-agent model overrides (settings/agents).
export const handleDashboardAgentOverrides = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const overrides = await runWithDb(layer, (db) =>
    agentOverrides(db, auth.tenantId),
  );
  return sendJson(res, 200, { overrides });
};

// GET /dashboard/connections — connector connections for the integrations
// pages + the case-detail Shopify shop-domain deep link.
export const handleDashboardConnections = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const connections = await runWithDb(layer, (db) =>
    connectionsList(db, auth.tenantId),
  );
  return sendJson(res, 200, { connections });
};

// GET /dashboard/shopify-app — whether the tenant can start a Shopify
// connect. In pilot custom distribution the Connect button gates on an
// operator-provisioned custom app; in SaaS it's always available.
export const handleDashboardShopifyApp = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const exit = await Effect.runPromiseExit(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* ShopifyAppProvisioningStore;
        return yield* store.get(TenantId(auth.tenantId));
      }),
      layer,
    ),
  );
  if (exit._tag !== "Success") {
    return sendJson(res, 500, {
      error: "lookup_failed",
      detail: opaqueCause(exit.cause),
    });
  }
  const row = exit.value;
  // `available` mirrors the authoritative install/mint gate
  // (resolveShopifyAppForTenant) instead of re-deriving it from the row, so
  // the Connect button can never be enabled for a workspace whose install
  // would be refused — and never enabled by a fallback the gate forbids.
  const app = await resolveTenantShopifyApp(cfg, layer, auth.tenantId);
  return sendJson(res, 200, {
    requiresProvisioning: cfg.shopifyConnectRequiresProvisioning,
    provisioned: row !== null && row.status !== "revoked",
    status: row?.status ?? null,
    available: app.kind === "ok",
  });
};

// GET /dashboard/audit?action=&actor=&page=&limit= — cross-case audit log.
export const handleDashboardAudit = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    auditList(
      db,
      auth.tenantId,
      { action: strField(q, "action"), actor: strField(q, "actor") },
      parsePageNumber(strField(q, "page")),
      parsePageSize(strField(q, "limit")),
    ),
  );
  return sendJson(res, 200, result);
};

// POST /dashboard/approvals/:id/{approve,reject} — manager decision. Reuses
// the same applyApprovalDecision + decisionToEvent + pg-boss publish as the
// email-link flow, but tenant-scoped and with the real manager id. Body may
// carry { approvedInput } for edit-and-approve.
export const handleDashboardApprovalAction =
  (action: "approve" | "reject") =>
  async (
    cfg: ApiConfig,
    layer: ApiLayer,
    req: FastifyRequest,
    res: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = await authenticateDashboard(cfg, layer, req);
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
    if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
    const { id } = req.params as { id: string };
    // Route guard already enforced approvals.decide. Approving a refund-bearing
    // action additionally requires refunds.issue (rejecting one does not — it
    // moves no money). Open mode / owner short-circuit inside decideAuthz.
    if (action === "approve") {
      const detail = await runWithDb(layer, (db) =>
        approvalDetail(db, auth.tenantId, id),
      );
      if (detail && detail.tool === "refund.create") {
        const access = await runWithDb(layer, (db) =>
          getMemberAccess(db, auth.tenantId, auth.userId!),
        );
        const decision = decideAuthz(access, auth.userId, "refunds.issue");
        if (!decision.ok) {
          return sendJson(res, decision.status, { error: decision.error });
        }
      }
    }
    const approvedInput = parseJsonBody(req)["approvedInput"];
    const managerId = UserId(auth.userId);
    const result = await Effect.runPromise(
      Effect.provide(
        applyApprovalDecision({
          approvalId: id,
          action,
          managerId,
          tenantId: TenantId(auth.tenantId),
          ...(approvedInput !== undefined ? { approvedInput } : {}),
        }),
        layer,
      ),
    );
    const event = decisionToEvent(result, action, managerId);
    if (event) {
      try {
        await makePgBossApprovalPublisher(() =>
          acquireApprovalBoss(cfg.databaseUrl),
        )(event);
      } catch (cause) {
        // Row already decided; the worker just won't pick it up until ops
        // replays. Don't fail the request over a publish hiccup.
        // eslint-disable-next-line no-console
        console.error(
          "[dashboard approvals] publish failed; row decided without event",
          { approvalId: id, cause },
        );
      }
    }
    const status = result.kind === "approval_not_found" ? 404 : 200;
    return sendJson(res, status, result);
  };

// POST /dashboard/cases/:id/takeover — manager takes over a case.
export const handleDashboardTakeover = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const managerId = auth.userId;
  const outcome = await runWithDb(layer, (db) =>
    takeOverCase(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/resume — manager hands a taken-over case back
// to the agent. The status flips out of `human_takeover` so the runtime's
// takeover guard stops holding events and the agent resumes on the next
// inbound message.
export const handleDashboardResume = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const managerId = auth.userId;
  const outcome = await runWithDb(layer, (db) =>
    resumeCase(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/status — manager manually sets the case status
// (e.g. mark resolved, reopen, or park waiting on the customer). The move is
// validated against the case state machine (§10) in the same tx that writes
// the transition + audit rows; pending approvals are canceled. Like resume,
// this is a pure DB transition — it does NOT tick the agent (the merchant uses
// "Retry now" for that).
export const handleDashboardSetCaseStatus = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const toStatus = typeof body["status"] === "string" ? body["status"] : "";
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const outcome = await runWithDb(layer, (db) =>
    setCaseStatus(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId: auth.userId!,
      toStatus,
      reason,
    }),
  );
  const status =
    outcome.kind === "case_not_found"
      ? 404
      : outcome.kind === "invalid_status"
        ? 400
        : outcome.kind === "transition_not_allowed"
          ? 409
          : 200; // updated | unchanged
  return sendJson(res, status, outcome);
};

// POST /dashboard/cases/:id/retry — manager hands a taken-over case back
// AND has the agent try again immediately: the resume flip plus a
// `case.resumed` workflow event, so the worker ticks now instead of
// waiting for the customer's next message.
export const handleDashboardRetry = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const managerId = auth.userId;
  // `fromTriage: true` → full retry: rebind to triage so the tick re-classifies
  // and re-routes. Default (absent/false) → re-run the bound specialist.
  const body = parseJsonBody(req);
  const fromTriage = body["fromTriage"] === true;
  const outcome = await retryCaseNow({
    caseId: id,
    fromTriage,
    // Fresh per click so this restart re-runs the agent's tools instead of
    // deduping against the prior attempt (see deliveryScopeFor / case.resumed).
    resumeToken: randomUUID(),
    resume: () =>
      runWithDb(layer, (db) =>
        resumeCase(db, {
          caseId: id,
          tenantId: auth.tenantId,
          managerId,
          reason: fromTriage
            ? "manager asked the agent to restart from triage (full retry)"
            : "manager asked the agent to retry from the dashboard",
          restartFromTriage: fromTriage,
        }),
      ),
    publish: makePgBossApprovalPublisher(() =>
      acquireApprovalBoss(cfg.databaseUrl),
    ),
  });
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/retry-send — re-send the SAME drafted customer
// reply whose delivery failed (distinct from /retry, which re-runs the agent).
// Requeues the case's reply-delivery outbox row (fresh attempt budget, due
// now); the worker's reply-delivery-retry sweep re-sends it within the minute
// and auto-resolves the case on success.
export const handleDashboardRetrySend = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const outcome = await runWithDb(layer, async (db) => {
    // Tenant-scope the action: the outbox row carries its tenant, so a case id
    // from another workspace finds nothing.
    const active = await getActiveReplyDeliveryForCase(db, id);
    if (!active || active.tenantId !== auth.tenantId) {
      return { kind: "no_failed_delivery" as const };
    }
    const requeued = await requeueReplyDeliveryNow(db, id);
    return requeued
      ? { kind: "queued" as const }
      : { kind: "no_failed_delivery" as const };
  });
  return sendJson(
    res,
    outcome.kind === "no_failed_delivery" ? 404 : 200,
    outcome,
  );
};

// POST /dashboard/cases/:id/reply — a human drafts and sends a customer-facing
// reply directly, while driving the case in `human_takeover`. The reply goes
// out on the SAME connector/thread the agent uses (ConversationService.reply),
// so threading stays natural; the case stays in `human_takeover` (no
// auto-resolve — the person decides when they're done). The orchestration +
// guards live in the unit-tested `sendManualReply` core; this handler wires it
// to the live services.
export const handleDashboardCaseReply = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const bodyText = typeof body["bodyText"] === "string" ? body["bodyText"] : "";
  const bodyHtml =
    typeof body["bodyHtml"] === "string" ? (body["bodyHtml"] as string) : null;
  const tenantId = TenantId(auth.tenantId);
  const caseId = CaseId(id);
  const userId = auth.userId;
  // One idempotency key for this send; reused if the connector retries
  // internally within the request (master-plan §9).
  const draftId = `manual:${randomUUID()}`;

  // Resolve the live thread to learn who to reply to (the customer) + which
  // message to thread under. Never fails — degrades to a tagged error result
  // the core surfaces as `send_failed`.
  const deliverEffect = (threadId: string, mailbox: string) =>
    Effect.gen(function* () {
      const cases = yield* CaseRepository;
      const conversation = yield* ConversationService;
      const connectorStore = yield* ConnectorCredentialStore;
      const rawThreadId = parseThreadId(threadId)?.raw ?? threadId;
      const provider =
        parseThreadId(threadId)?.provider ??
        (yield* cases.findThreadProvider(tenantId, ThreadId(threadId)));
      const connections = yield* connectorStore.listForTenant(tenantId);
      const resolution = yield* resolveCaseConversationThread(
        mailbox,
        provider,
        connections,
        (candidateProvider, mb) =>
          conversation.fetchThread(
            tenantId,
            namespaceThreadId(candidateProvider, rawThreadId),
            mb,
          ),
      );
      if (!resolution.ok) {
        return { kind: "error" as const, error: `thread_${resolution.reason}` };
      }
      // Reply to the latest inbound message's sender (the customer) and thread
      // under it; fall back to any thread participant that isn't our mailbox.
      const own = mailbox.trim().toLowerCase();
      const inbound = resolution.thread.messages
        .filter((m) => m.direction === "inbound")
        .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
      const latestInbound = inbound[inbound.length - 1];
      const target = latestInbound
        ? {
            to: { name: latestInbound.from.name, email: latestInbound.from.email },
            inReplyToMessageId: latestInbound.id,
          }
        : (() => {
            const other = resolution.thread.participants.find(
              (p) => p.email.trim().toLowerCase() !== own,
            );
            return other
              ? {
                  to: { name: other.name, email: other.email },
                  inReplyToMessageId: null,
                }
              : null;
          })();
      if (!target) return { kind: "error" as const, error: "no_recipient" };
      const sent = yield* conversation
        .reply(tenantId, {
          threadId: ThreadId(threadId),
          mailbox,
          to: [target.to],
          // null → connector inherits the thread subject (`Re: <subject>`).
          subject: null,
          bodyText,
          bodyHtml,
          attachments: [],
          inReplyToMessageId: target.inReplyToMessageId,
          draftId,
        })
        .pipe(Effect.either);
      return sent._tag === "Left"
        ? { kind: "error" as const, error: sent.left._tag }
        : {
            kind: "ok" as const,
            sent: { id: sent.right.id, sentAt: sent.right.sentAt.toISOString() },
          };
    }).pipe(
      Effect.catchAll((e) =>
        Effect.succeed({
          kind: "error" as const,
          error:
            typeof (e as { _tag?: unknown })._tag === "string"
              ? String((e as { _tag: string })._tag)
              : String(e),
        }),
      ),
    );

  const outcome = await sendManualReply({
    bodyText,
    loadCase: () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cases = yield* CaseRepository;
            return yield* cases.getById(caseId, tenantId).pipe(
              Effect.map(
                (c): ManualReplyCaseView => ({
                  status: c.status,
                  threadId: c.threadId,
                  mailbox: c.mailbox,
                }),
              ),
            );
          }).pipe(Effect.catchAll(() => Effect.succeed(null))),
          layer,
        ),
      ),
    deliver: async ({ threadId, mailbox }) => {
      const result = await Effect.runPromise(
        Effect.provide(deliverEffect(threadId, mailbox), layer),
      );
      if (result.kind === "error") throw new Error(result.error);
      return result.sent;
    },
    recordSent: (sent) =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cases = yield* CaseRepository;
            const audit = yield* AuditLogService;
            // Index the outbound message id so the customer's next reply threads
            // back to this case (mirrors the runtime's recordOutboundReplyId).
            yield* cases
              .recordMessageId({
                tenantId,
                caseId,
                messageId: sent.id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .record({
                tenantId,
                caseId,
                actor: { type: "user", id: userId },
                action: "case.replied",
                details: { messageId: sent.id, via: "manual_reply" },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }),
          layer,
        ),
      ),
  });

  const status =
    outcome.kind === "sent"
      ? 200
      : outcome.kind === "case_not_found"
        ? 404
        : outcome.kind === "empty_body"
          ? 400
          : outcome.kind === "send_failed"
            ? 502
            : 409; // not_in_takeover | no_thread
  return sendJson(res, status, outcome);
};

// POST /dashboard/cases/:id/refund — operator issues an agent-recommended
// refund directly. Route-gated on `refunds.issue` (moving money is its own
// permission, not implied by any `cases.*`). The agent took PATH B and only
// *recommended* a refund (read-only `refund.recommend`), so there's no approval
// to approve — this runs the equivalent of `refund.create` under operator
// authorization. The orchestration + guards live in the unit-tested
// `issueCaseRefund` core; this handler wires it to the live services: resolve
// the case's order (same resolver the panel uses), issue via ShopifyService, and
// record a `case.refund_issued` audit row. Works regardless of case status, so a
// resolved case whose reply already promised the refund can still be paid.
export const handleDashboardIssueRefund = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const body = parseJsonBody(req);
  const amountRaw =
    body["amount"] && typeof body["amount"] === "object"
      ? (body["amount"] as Record<string, unknown>)
      : {};
  const amount = {
    amount: typeof amountRaw["amount"] === "string" ? amountRaw["amount"] : "",
    currencyCode:
      typeof amountRaw["currencyCode"] === "string"
        ? amountRaw["currencyCode"]
        : "",
  };
  const tenantId = TenantId(auth.tenantId);
  const caseId = CaseId(id);
  const userId = auth.userId;

  // Tenant-scoped case load → context (null = case missing / another tenant).
  const caseRow = await runWithDb(layer, (db) =>
    caseContextForTenant(db, auth.tenantId, id),
  );
  if (!caseRow) return sendJson(res, 404, { kind: "case_not_found" });
  const context = (caseRow.context ?? {}) as Record<string, unknown>;

  const outcome = await issueCaseRefund({
    amount,
    loadOrder: () =>
      Effect.runPromise(
        Effect.provide(
          resolveOrderForContext(tenantId, context).pipe(
            Effect.map((order) =>
              order
                ? {
                    orderId: String(order.id),
                    currencyCode: order.totalPrice.currencyCode,
                    financialStatus: order.financialStatus,
                  }
                : null,
            ),
          ),
          layer,
        ),
      ),
    refund: async ({ orderId, amount: money }) => {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const shopify = yield* ShopifyService;
            return yield* shopify
              .refundOrder(tenantId, {
                orderId: OrderId(orderId),
                amount: {
                  amount: money.amount,
                  currencyCode: money.currencyCode,
                },
                note: `Refund issued from dashboard (agent recommendation) — case ${id}`,
                notifyCustomer: true,
                // Stable over (case, order, amount) so a double-click / retry
                // can't double-refund (mirrors refund.create's idempotencyKey).
                idempotencyKey: `dash-refund:${id}:${orderId}:${money.amount}:${money.currencyCode}`,
              })
              .pipe(Effect.either);
          }),
          layer,
        ),
      );
      if (result._tag === "Left") throw new Error(result.left._tag);
      return {
        id: result.right.id,
        amount: {
          amount: result.right.amount.amount,
          currencyCode: result.right.amount.currencyCode,
        },
        createdAt: result.right.createdAt.toISOString(),
      };
    },
    recordIssued: (refund) =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const audit = yield* AuditLogService;
            yield* audit
              .record({
                tenantId,
                caseId,
                actor: { type: "user", id: userId },
                action: "case.refund_issued",
                details: {
                  refundId: refund.id,
                  amount: refund.amount.amount,
                  currencyCode: refund.amount.currencyCode,
                  via: "dashboard_recommendation",
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }),
          layer,
        ),
      ),
  });

  const status =
    outcome.kind === "issued"
      ? 200
      : outcome.kind === "order_not_found"
        ? 404
        : outcome.kind === "invalid_amount"
          ? 400
          : outcome.kind === "refund_failed"
            ? 502
            : 409; // already_refunded | currency_mismatch
  return sendJson(res, status, outcome);
};

// Default model for the one-shot "Rephrase with AI" action. A cheap, fast model
// is the right default for polishing a short reply; a tenant-configurable
// override lands in a later slice.
const REPHRASE_MODEL = "google/gemini-3.5-flash";

// POST /dashboard/rephrase — AI polish of a reply draft. One-shot text
// generation (LLMService.runToolCalling with no tools → a final message), spent
// against the tenant's own LLM credential. Returns the discriminated outcome
// (rephrased | empty_input | no_llm | failed); the orchestration + guards live
// in the unit-tested `rephraseDraft` core.
export const handleDashboardRephrase = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const body = parseJsonBody(req);
  const text = typeof body["text"] === "string" ? body["text"] : "";
  const tenantId = TenantId(auth.tenantId);

  // The tenant-configured rephrase model (picked via the composer dropdown),
  // falling back to the built-in default when unset or the row is missing.
  const model = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo
          .getSettings(tenantId)
          .pipe(Effect.either);
        const configured =
          settings._tag === "Right" ? settings.right.rephraseModel : null;
        return configured && configured.length > 0 ? configured : REPHRASE_MODEL;
      }),
      layer,
    ),
  );

  const outcome = await rephraseDraft({
    text,
    hasCredential: () =>
      Effect.runPromise(
        Effect.provide(
          resolveActiveLlmCredential(auth.tenantId).pipe(
            Effect.map((c) => c !== null),
          ),
          layer,
        ),
      ),
    generate: async (draft) => {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const llm = yield* LLMService;
            return yield* llm
              .runToolCalling({
                tenantId,
                model,
                system: REPHRASE_SYSTEM,
                messages: buildRephraseMessages(draft),
                tools: [],
                temperature: 0.4,
              })
              .pipe(Effect.either);
          }),
          layer,
        ),
      );
      if (result._tag === "Left") {
        const tag = (result.left as { readonly _tag?: unknown })._tag;
        throw new Error(typeof tag === "string" ? tag : "llm_error");
      }
      return result.right.type === "final_message" ? result.right.text : null;
    },
  });

  const status =
    outcome.kind === "rephrased"
      ? 200
      : outcome.kind === "empty_input"
        ? 400
        : outcome.kind === "no_llm"
          ? 403
          : 502; // failed
  return sendJson(res, status, outcome);
};
