import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  applyApprovalDecision,
  ApprovalService,
  AuditLogService,
  CaseRepository,
  ConnectorCredentialStore,
  ConversationService,
  decideApprovalBundle,
  decisionToEvent,
  LLMService,
  ShopifyService,
  TenantRepository,
  TrackingService,
  parseThreadId,
  namespaceThreadId,
  ShopifyAppProvisioningStore,
} from "@support-agent/services";
import {
  ApprovalId,
  CaseId,
  OrderId,
  TenantId,
  ThreadId,
  UserId,
  type TrackingLookup,
} from "@support-agent/agent-core";
import type {
  CaseTrackingResult,
  DashboardTracking,
  DashboardTrackingScan,
} from "@support-agent/dashboard-contracts";
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
  editCaseDetails,
  escalateCaseToSupplier,
  getActiveReplyDeliveryForCase,
  getMemberAccess,
  parsePageNumber,
  parsePageSize,
  requeueReplyDeliveryNow,
  resolveCaseManually,
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
import { resendApprovedReply } from "./case-resend.js";
import { issueCaseRefund } from "./case-refund.js";
import { describeShopifyError } from "./shopify-error-detail.js";
import { dashboardRefundNote } from "./refund-note.js";
import { parseRefundLineItems, parseRefundShipping } from "./refund-input.js";
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
import {
  classifyOrderRef,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from "./case-details-input.js";
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

// GET /dashboard/cases?q=&status=&excludeStatus=&page=&limit= — paginated cases
// list, optional search + status include/exclude filters.
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
      {
        q: strField(q, "q"),
        status: strList(q, "status"),
        excludeStatus: strList(q, "excludeStatus"),
      },
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

// Serialize a TrackingLookup (Dates → ISO) for the dashboard tracking card.
const serializeTracking = (t: TrackingLookup): DashboardTracking => {
  if (t.kind === "no_provider") {
    return {
      kind: "no_provider",
      trackingNumber: t.trackingNumber,
      carrier: t.carrier,
      status: null,
      lastScan: null,
      estimatedDeliveryAt: null,
      trackingUrl: t.trackingUrl,
      originCountry: null,
      destinationCountry: null,
      transitDays: null,
      checkpoints: [],
      reason: t.reason,
    };
  }
  const scan = (
    s: { occurredAt: Date; location: string | null; description: string } | null,
  ): DashboardTrackingScan | null =>
    s
      ? {
          occurredAt: s.occurredAt.toISOString(),
          location: s.location,
          description: s.description,
        }
      : null;
  return {
    kind: "live",
    trackingNumber: t.trackingNumber,
    carrier: t.carrier,
    status: t.status,
    lastScan: scan(t.lastScan),
    estimatedDeliveryAt: t.estimatedDeliveryAt
      ? t.estimatedDeliveryAt.toISOString()
      : null,
    trackingUrl: t.trackingUrl,
    originCountry: t.originCountry ?? null,
    destinationCountry: t.destinationCountry ?? null,
    transitDays: t.transitDays ?? null,
    checkpoints: (t.checkpoints ?? []).flatMap((c) => {
      const s = scan(c);
      return s ? [s] : [];
    }),
    reason: null,
  };
};

// GET /dashboard/cases/:id/tracking — fresh carrier status for the case's
// shipment, fed to the case-detail Tracking card. The tracking number comes
// from the agent's `liveTrackingStatus` stamp when present, else the order's
// fulfillment; a live 17track lookup (TrackingService) returns the rich result.
// Best-effort: no number → `no_tracking_number`, provider error → `unavailable`
// (the card falls back to the on-case stamp).
export const handleDashboardCaseTracking = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result: CaseTrackingResult = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        const caseRow = yield* Effect.promise(() =>
          caseContextForTenant(db, auth.tenantId, id),
        );
        if (!caseRow) return { kind: "not_found" as const };
        const context = (caseRow.context ?? {}) as Record<string, unknown>;
        const stamp =
          typeof context["liveTrackingStatus"] === "object" &&
          context["liveTrackingStatus"] !== null
            ? (context["liveTrackingStatus"] as Record<string, unknown>)
            : null;
        let trackingNumber =
          typeof stamp?.["trackingNumber"] === "string" &&
          stamp["trackingNumber"]
            ? (stamp["trackingNumber"] as string)
            : null;
        let carrier =
          typeof stamp?.["carrier"] === "string" && stamp["carrier"]
            ? (stamp["carrier"] as string)
            : null;
        if (!trackingNumber) {
          const order = yield* resolveOrderForContext(
            TenantId(auth.tenantId),
            context,
          );
          const f =
            order?.fulfillments.find((ff) => ff.trackingNumbers.length > 0) ??
            null;
          trackingNumber = f?.trackingNumbers[0] ?? null;
          carrier = carrier ?? f?.trackingCompany ?? null;
        }
        if (!trackingNumber) return { kind: "no_tracking_number" as const };
        const trackingSvc = yield* TrackingService;
        const tracking = yield* trackingSvc
          .lookup(TenantId(auth.tenantId), { trackingNumber, carrier })
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!tracking) return { kind: "unavailable" as const };
        return { kind: "ok" as const, tracking: serializeTracking(tracking) };
      }),
      layer,
    ),
  );
  return sendJson(res, result.kind === "not_found" ? 404 : 200, result);
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
      // A cancellation issues a refund too, so it needs the same refunds.issue
      // permission as a refund approval.
      if (
        detail &&
        (detail.tool === "refund.create" || detail.tool === "order.cancel")
      ) {
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

// POST /dashboard/cases/:id/approvals/{approve,reject} — decide the WHOLE
// pending bundle for a case in one click (autonomous loop, slice 7). The
// scenario agent queues several gated actions on one case; this approves (or
// rejects) every pending row, then publishes ONE event so the runtime executes
// the bundle in order (the slice-4d resume contract: all rows decided BEFORE the
// event fires, else a per-row event could resolve the case while siblings are
// still pending). `approve` accepts an optional `{ edits: { [approvalId]: input } }`
// so an edited reply draft flows through; `reject` moves no money and takes none.
export const handleDashboardCaseApprovalsBundle =
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
    const { id: caseId } = req.params as { id: string };
    const managerId = UserId(auth.userId);

    // Every pending row for the case, in creation (= proposal) order.
    const pending = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ApprovalService;
          const all = yield* svc.listForCase(
            TenantId(auth.tenantId),
            CaseId(caseId),
          );
          return all.filter((a) => a.status === "pending");
        }),
        layer,
      ),
    );
    if (pending.length === 0) {
      return sendJson(res, 200, { kind: "no_pending", count: 0 });
    }

    // Approving a bundle that moves money needs refunds.issue on top of the
    // route's approvals.decide guard (rejecting moves no money → no extra gate).
    if (
      action === "approve" &&
      pending.some(
        (a) => a.tool === "refund.create" || a.tool === "order.cancel",
      )
    ) {
      const access = await runWithDb(layer, (db) =>
        getMemberAccess(db, auth.tenantId, auth.userId!),
      );
      const decision = decideAuthz(access, auth.userId, "refunds.issue");
      if (!decision.ok) {
        return sendJson(res, decision.status, { error: decision.error });
      }
    }

    const edits =
      action === "approve"
        ? ((parseJsonBody(req)["edits"] as
            | Record<string, unknown>
            | undefined) ?? {})
        : {};

    // Decide every pending row + get the single event to publish (the bundle
    // contract lives in decideApprovalBundle: decide ALL, then one event).
    const { decidedCount, event } = await Effect.runPromise(
      Effect.provide(
        decideApprovalBundle({
          tenantId: TenantId(auth.tenantId),
          caseId: CaseId(caseId),
          action,
          managerId,
          edits,
        }),
        layer,
      ),
    );

    // Publish ONE event AFTER all rows are decided. The runtime gathers every
    // approved row for the case and runs them in order (slice 4d).
    if (event) {
      try {
        await makePgBossApprovalPublisher(() =>
          acquireApprovalBoss(cfg.databaseUrl),
        )(event);
      } catch (cause) {
        // Rows are decided; the worker just won't pick them up until ops
        // replays. Don't fail the request over a publish hiccup.
        // eslint-disable-next-line no-console
        console.error(
          "[dashboard approvals] bundle publish failed; rows decided without event",
          { caseId, cause },
        );
      }
    }

    return sendJson(res, 200, {
      kind: "decided",
      action,
      count: decidedCount,
    });
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

// POST /dashboard/cases/:id/resolve — manager closes a case by hand, including
// one they've TAKEN OVER ("Resolve" button on the case page). Distinct from the
// status endpoint: resolving a `human_takeover` case is a legitimate human close
// (the manager owns it and is done), so this goes through the lifecycle bridge
// (`human_takeover → in_progress → resolved`) rather than the forbidden direct
// jump the status endpoint refuses. Gated on the same permission as a manual
// status change.
export const handleDashboardResolveCase = async (
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
  const outcome = await runWithDb(layer, (db) =>
    resolveCaseManually(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId: auth.userId!,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "case_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/cases/:id/escalate-supplier — manager hands the case to the
// workspace's supplier by hand ("Escalate to supplier" in the case-page menu).
// Same machinery as the agent's supplier.escalate tool: the escalation row is
// the notify outbox (worker cron emails the supplier), and the case parks in
// waiting_for_supplier — bridging from human_takeover, or staying parked on
// approval when that's the primary wait. The problem statement is required:
// it's what the supplier sees in the portal + email.
export const handleDashboardEscalateSupplier = async (
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
  const problem =
    typeof body["problem"] === "string" ? body["problem"].trim() : "";
  if (problem.length === 0) {
    return sendJson(res, 400, { error: "missing_problem" });
  }
  const reason =
    typeof body["reason"] === "string" ? (body["reason"] as string) : undefined;
  const outcome = await runWithDb(layer, (db) =>
    escalateCaseToSupplier(db, {
      caseId: id,
      tenantId: auth.tenantId,
      managerId: auth.userId!,
      problem,
      reason,
    }),
  );
  const status =
    outcome.kind === "case_not_found"
      ? 404
      : outcome.kind === "no_supplier" ||
          outcome.kind === "transition_not_allowed"
        ? 409
        : 200; // escalated | already_escalated
  return sendJson(res, status, outcome);
};

// POST /dashboard/cases/:id/details — a manager hand-corrects the customer
// and/or order the agent couldn't extract (the pencil edit on the Customer /
// Order cards). Rarely needed, but it must never leave the manager blocked on a
// case: e.g. a legacy relay case created before Reply-To parsing landed, stamped
// with `mailer@shopify.com` as the customer. The order ref is resolved to its
// canonical Shopify order HERE (this handler holds ShopifyService) so we stamp
// the same `identifiedOrderId` GID the runtime would — an unresolvable ref is
// still recorded as `quotedOrderRef` so the panel shows the hint. Only the
// provided fields change; no status transition (details are metadata). Gated on
// `cases.set_status` (the "correct case state by hand" permission).
export const handleDashboardEditCaseDetails = async (
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

  // Customer email: validate only when the field is present + non-blank; a
  // malformed address is refused rather than stamped as the reply target.
  const rawEmail = body["customerEmail"];
  const hasEmailField =
    typeof rawEmail === "string" && rawEmail.trim() !== "";
  const customerEmail = hasEmailField
    ? normalizeCustomerEmail(rawEmail)
    : undefined;
  if (hasEmailField && customerEmail === null) {
    return sendJson(res, 400, { kind: "invalid_email" });
  }
  const customerName =
    typeof body["customerName"] === "string"
      ? (normalizeCustomerName(body["customerName"]) ?? undefined)
      : undefined;
  const customerPhone =
    typeof body["customerPhone"] === "string"
      ? (normalizeCustomerPhone(body["customerPhone"]) ?? undefined)
      : undefined;
  const rawOrderRef =
    typeof body["orderRef"] === "string" ? body["orderRef"].trim() : "";
  const orderRef = rawOrderRef.length > 0 ? rawOrderRef : undefined;

  if (
    customerEmail === undefined &&
    customerName === undefined &&
    customerPhone === undefined &&
    orderRef === undefined
  ) {
    return sendJson(res, 400, { kind: "nothing_to_update" });
  }

  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        // Best-effort resolve the typed order ref to its canonical Shopify
        // order (mirrors resolveOrderForContext). A miss (no creds, 404) leaves
        // identifiedOrderId unset; the raw ref is still saved as quotedOrderRef.
        let identifiedOrderId: string | undefined;
        let orderName: string | null = null;
        if (orderRef) {
          const shopify = yield* ShopifyService;
          const tenant = TenantId(auth.tenantId);
          const kind = classifyOrderRef(orderRef);
          const lookup =
            kind === "gid"
              ? shopify.getOrder(tenant, OrderId(orderRef))
              : kind === "name"
                ? shopify.findOrderByName(tenant, orderRef)
                : shopify.findOrderByConfirmationNumber(tenant, orderRef);
          const order = yield* lookup.pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (order) {
            identifiedOrderId = order.id;
            orderName = order.name;
          }
        }
        const outcome = yield* Effect.promise(() =>
          editCaseDetails(db, {
            caseId: id,
            tenantId: auth.tenantId,
            managerId: auth.userId!,
            ...(customerEmail ? { customerEmail } : {}),
            ...(customerName !== undefined ? { customerName } : {}),
            ...(customerPhone !== undefined ? { customerPhone } : {}),
            ...(identifiedOrderId !== undefined ? { identifiedOrderId } : {}),
            ...(orderRef !== undefined ? { quotedOrderRef: orderRef } : {}),
          }),
        );
        return {
          outcome,
          // Only meaningful when an order ref was submitted.
          orderResolved:
            orderRef !== undefined ? identifiedOrderId !== undefined : undefined,
          orderName,
        };
      }),
      layer,
    ),
  );

  if (result.outcome.kind === "case_not_found") {
    return sendJson(res, 404, { kind: "case_not_found" });
  }
  return sendJson(res, 200, {
    kind: "saved",
    ...(result.orderResolved !== undefined
      ? { orderResolved: result.orderResolved }
      : {}),
    ...(result.orderName ? { orderName: result.orderName } : {}),
  });
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

// A conversation.reply approval's stored input (the manager-approved draft).
// proposedInput is `unknown` at the type level — decode it defensively before
// re-sending. Returns null when the shape isn't a usable reply.
interface DecodedApprovedReply {
  readonly threadId: string;
  readonly to: ReadonlyArray<{ readonly name: string | null; readonly email: string }>;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
  readonly inReplyToMessageId: string | null;
  readonly draftId: string;
}

const decodeApprovedReply = (input: unknown): DecodedApprovedReply | null => {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const threadId = typeof o["threadId"] === "string" ? o["threadId"] : null;
  const bodyText = typeof o["bodyText"] === "string" ? o["bodyText"] : null;
  const draftId = typeof o["draftId"] === "string" ? o["draftId"] : null;
  if (!threadId || bodyText === null || !draftId) return null;
  const to = Array.isArray(o["to"])
    ? o["to"]
        .filter(
          (p): p is { name?: unknown; email: string } =>
            !!p && typeof p === "object" && typeof (p as { email?: unknown }).email === "string",
        )
        .map((p) => ({
          name: typeof p.name === "string" ? p.name : null,
          email: p.email,
        }))
    : [];
  if (to.length === 0) return null;
  return {
    threadId,
    to,
    subject: typeof o["subject"] === "string" ? o["subject"] : null,
    bodyText,
    bodyHtml: typeof o["bodyHtml"] === "string" ? o["bodyHtml"] : null,
    inReplyToMessageId:
      typeof o["inReplyToMessageId"] === "string" ? o["inReplyToMessageId"] : null,
    draftId,
  };
};

// POST /dashboard/cases/:id/resend-approval — resend an approved customer reply
// that was never sent (skipped when the case was taken over — audit
// `approval.stale_delivery_skipped`). Re-sends the EXACT approved draft on the
// same thread (idempotent on (mailbox, draftId), so a retry can't double-send);
// the case stays in `human_takeover` for the operator. Orchestration + guards
// live in the unit-tested `resendApprovedReply` core.
export const handleDashboardResendApproval = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const tenantId = TenantId(auth.tenantId);
  const caseId = CaseId(id);
  const userId = auth.userId;

  // One tenant-scoped read serves both the status guard and the resurfaceable
  // approval lookup (memoised so the core's two calls don't double-query).
  let detailP: Promise<Awaited<ReturnType<typeof caseDetail>>> | null = null;
  const loadDetail = () =>
    (detailP ??= runWithDb(layer, (db) => caseDetail(db, auth.tenantId, id)));

  const deliverEffect = (approvalId: string) =>
    Effect.gen(function* () {
      const approvalsSvc = yield* ApprovalService;
      const cases = yield* CaseRepository;
      const conversation = yield* ConversationService;
      const approval = yield* approvalsSvc
        .getById(ApprovalId(approvalId), tenantId)
        .pipe(Effect.either);
      if (approval._tag === "Left") {
        return { kind: "error" as const, error: "approval_not_found" };
      }
      const reply = decodeApprovedReply(approval.right.proposedInput);
      if (!reply) return { kind: "error" as const, error: "bad_draft" };
      const caseRow = yield* cases.getById(caseId, tenantId).pipe(Effect.either);
      if (caseRow._tag === "Left") {
        return { kind: "error" as const, error: "case_not_found" };
      }
      const mailbox = caseRow.right.mailbox;
      if (!mailbox) return { kind: "error" as const, error: "no_mailbox" };
      const sent = yield* conversation
        .reply(tenantId, {
          threadId: ThreadId(reply.threadId),
          mailbox,
          to: reply.to.map((p) => ({ name: p.name, email: p.email })),
          subject: reply.subject,
          bodyText: reply.bodyText,
          bodyHtml: reply.bodyHtml,
          attachments: [],
          inReplyToMessageId: reply.inReplyToMessageId,
          draftId: reply.draftId,
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

  const outcome = await resendApprovedReply({
    loadCaseStatus: async () => {
      const detail = await loadDetail();
      return detail ? detail.case.status : null;
    },
    findResurfaceableApprovalId: async () => {
      const detail = await loadDetail();
      return detail?.approvedNotSent?.approvalId ?? null;
    },
    deliver: async (approvalId) => {
      const result = await Effect.runPromise(
        Effect.provide(deliverEffect(approvalId), layer),
      );
      if (result.kind === "error") throw new Error(result.error);
      return result.sent;
    },
    recordResent: (approvalId, sent) =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const cases = yield* CaseRepository;
            const audit = yield* AuditLogService;
            yield* cases
              .recordMessageId({
                tenantId,
                caseId,
                messageId: sent.id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
            // Retires the "approved but not sent" card (detection keys on this).
            yield* audit
              .record({
                tenantId,
                caseId,
                actor: { type: "user", id: userId },
                action: "case.approved_reply_resent",
                details: { approvalId, messageId: sent.id },
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .record({
                tenantId,
                caseId,
                actor: { type: "user", id: userId },
                action: "case.replied",
                details: { messageId: sent.id, via: "resend_approved" },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }),
          layer,
        ),
      ),
  });

  const status =
    outcome.kind === "resent"
      ? 200
      : outcome.kind === "case_not_found" || outcome.kind === "nothing_to_resend"
        ? 404
        : outcome.kind === "send_failed"
          ? 502
          : 409; // not_in_takeover
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
  // The dashboard refund modal adds the optional staff reason ("Reason for
  // refund"), the restock line selection, and the shipping refund. The agent
  // recommendation path posts none of these (amount-only).
  const reasonRaw = body["reason"];
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim() : null;
  const lineItems = parseRefundLineItems(body["lineItems"]);
  const shipping = parseRefundShipping(body["shipping"]);
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
                note: dashboardRefundNote({ caseId: id, reason }),
                notifyCustomer: true,
                // Stable over (case, order, amount) so a double-click / retry
                // can't double-refund (mirrors refund.create's idempotencyKey).
                idempotencyKey: `dash-refund:${id}:${orderId}:${money.amount}:${money.currencyCode}`,
                // Restock selection + shipping refund from the modal; absent on
                // the agent-recommendation (amount-only) path.
                ...(lineItems.length > 0 ? { lineItems } : {}),
                ...(shipping ? { shipping } : {}),
              })
              .pipe(Effect.either);
          }),
          layer,
        ),
      );
      if (result._tag === "Left") {
        // Log the FULL typed error (incl. NetworkError.cause /
        // ShopifyResponseInvalid.message) so a Shopify-side rejection is
        // diagnosable from the API logs — the bare `_tag` alone hid the real
        // cause behind an opaque 502. Throw the descriptive detail too.
        const detail = describeShopifyError(result.left);
        req.log.error(
          {
            err: result.left,
            shopifyErrorTag: result.left._tag,
            tenantId,
            orderId,
            caseId: id,
          },
          `dashboard issue-refund: Shopify refundOrder failed — ${detail}`,
        );
        throw new Error(detail);
      }
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
                  via: "dashboard",
                  ...(reason ? { reason } : {}),
                  ...(lineItems.length > 0
                    ? {
                        restockedLines: lineItems.filter(
                          (li) => li.restockType !== "NO_RESTOCK",
                        ).length,
                      }
                    : {}),
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

// GET /dashboard/cases/:id/refund-context — everything the dashboard's
// Shopify-style refund modal needs to render and price a refund: the refundable
// line items (with per-unit pricing from Shopify's own `suggestedRefund`), the
// refundable shipping, the maximum refundable, the payment-method label, and
// the store's stock locations. Route-gated on `refunds.issue` (it's the first
// step of issuing a refund). Resolves the case's order with the same resolver
// the order panel + issue-refund handler use, so the modal acts on exactly the
// order the agent identified.
export const handleDashboardRefundContext = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const tenantId = TenantId(auth.tenantId);

  const caseRow = await runWithDb(layer, (db) =>
    caseContextForTenant(db, auth.tenantId, id),
  );
  if (!caseRow) return sendJson(res, 404, { kind: "case_not_found" });
  const context = (caseRow.context ?? {}) as Record<string, unknown>;

  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const order = yield* resolveOrderForContext(tenantId, context);
        if (!order) return { kind: "order_not_found" as const };
        const shopify = yield* ShopifyService;
        const ctx = yield* shopify
          .getOrderRefundContext(tenantId, OrderId(String(order.id)))
          .pipe(Effect.either);
        return ctx._tag === "Left"
          ? { kind: "context_unavailable" as const }
          : { kind: "ok" as const, context: ctx.right };
      }),
      layer,
    ),
  );

  const status =
    outcome.kind === "ok"
      ? 200
      : outcome.kind === "order_not_found"
        ? 404
        : 502; // context_unavailable
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
