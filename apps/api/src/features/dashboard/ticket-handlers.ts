import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  applyApprovalDecision,
  ApprovalService,
  AuditLogService,
  BlobStorage,
  TicketAttachmentStore,
  TicketRepository,
  ConnectorCredentialStore,
  ConversationService,
  decideApprovalBundle,
  decisionToEvent,
  LLMService,
  normalizeBlockedSenderInput,
  ShopifyService,
  TenantRepository,
  toMessageAttachment,
  TrackingService,
  parseThreadId,
  namespaceThreadId,
  ShopifyAppProvisioningStore,
} from "@support-agent/services";
import { addBlockedSenderEntry } from "./settings-handlers.js";
import {
  ApprovalId,
  TicketId,
  OrderId,
  TenantId,
  ThreadId,
  UserId,
  type TrackingLookup,
} from "@support-agent/agent-core";
import type {
  TicketTrackingResult,
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
  ticketContextForTenant,
  ticketDetail,
  ticketEvents,
  ticketsList,
  connectionsList,
  DbClient,
  editTicketDetails,
  escalateTicketToSupplier,
  getActiveReplyDeliveryForTicket,
  getMemberAccess,
  parsePageNumber,
  parsePageSize,
  requeueReplyDeliveryNow,
  resolveTicketManually,
  resumeTicket,
  setTicketStatus,
  takeOverTicket,
  todaySummary,
  usageRows,
} from "@support-agent/db";
import { decideAuthz } from "../../auth/dashboard-authz.js";
import { retryTicketNow } from "./ticket-retry.js";
import {
  sendManualReply,
  type ManualReplyTicketView,
} from "./ticket-reply.js";
import { resendApprovedReply } from "./ticket-resend.js";
import { issueTicketRefund } from "./ticket-refund.js";
import {
  parseShippingAddressFields,
  updateTicketShippingAddress,
} from "./ticket-shipping-address.js";
import {
  cancelTicketOrder,
  parseCancelOrderBody,
} from "./ticket-cancel-order.js";
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
  resolveTicketConversationThread,
} from "./conversation-thread.js";
import {
  resolveCustomerForContext,
  resolveOrderForContext,
} from "./shopify-panels.js";
import { pickTrackingSource } from "./ticket-tracking-source.js";
import {
  resolveCanonicalOrder,
  supplierOrderProjection,
} from "./escalation-projection.js";
import {
  classifyOrderRef,
  normalizeCustomerEmail,
  normalizeCustomerName,
  normalizeCustomerPhone,
} from "./ticket-details-input.js";
import {
  toAttachmentSummary,
  uploadStorageKey,
  validateAttachmentUpload,
} from "./attachment-upload.js";
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

// GET /dashboard/tickets?q=&status=&excludeStatus=&page=&limit= — paginated tickets
// list, optional search + status include/exclude filters.
export const handleDashboardTickets = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const q = (req.query ?? {}) as Record<string, unknown>;
  const result = await runWithDb(layer, (db) =>
    ticketsList(
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

// GET /dashboard/tickets/:id — ticket + timeline + approvals.
export const handleDashboardTicketDetail = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result = await runWithDb(layer, (db) =>
    ticketDetail(db, auth.tenantId, id),
  );
  if (!result) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, result);
};

// GET /dashboard/tickets/:id/conversation-thread — live provider thread for the
// third ticket-timeline view. The ticket lookup is tenant-scoped before any
// provider call, and connector failures degrade to a stable UI result.
export const handleDashboardTicketConversationThread = async (
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
        const tickets = yield* TicketRepository;
        const conversation = yield* ConversationService;
        const connectorStore = yield* ConnectorCredentialStore;
        const ticketRow = yield* tickets
          .getById(TicketId(id), TenantId(auth.tenantId))
          .pipe(Effect.catchTag("TicketNotFound", () => Effect.succeed(null)));
        if (!ticketRow) return { kind: "not_found" as const };
        if (!ticketRow.threadId) {
          return {
            kind: "result" as const,
            result: {
              status: "unavailable" as const,
              reason: "no_thread" as const,
            },
          };
        }
        const threadId = ticketRow.threadId;
        const rawThreadId = parseThreadId(threadId)?.raw ?? threadId;
        const provider =
          parseThreadId(threadId)?.provider ??
          (yield* tickets.findThreadProvider(TenantId(auth.tenantId), threadId));
        const connections = yield* connectorStore.listForTenant(
          TenantId(auth.tenantId),
        );
        // The ticket's attachment index supplies previewable files: connectors
        // report none on a fetched thread. Best-effort — a store hiccup costs
        // the previews, not the conversation.
        const attachmentStore = yield* TicketAttachmentStore;
        const attachmentIndex = yield* attachmentStore
          .listMessageBindingsForTicket(TenantId(auth.tenantId), TicketId(id))
          .pipe(Effect.orElseSucceed(() => []));
        const threadResult = yield* resolveTicketConversationThread(
          ticketRow.mailbox,
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
                    thread: projectConversationThread(
                      resolution.thread,
                      attachmentIndex,
                    ),
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

// GET /dashboard/tickets/:id/events?since= — audit rows after `since` (poll).
export const handleDashboardTicketEvents = async (
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
    ticketEvents(db, auth.tenantId, id, since),
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

// GET /dashboard/tickets/:id/shopify — ticket-detail Shopify panels (customer +
// order + active shop domain). Best-effort: Shopify failures yield nulls.
export const handleDashboardTicketShopify = async (
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
          ticketContextForTenant(db, auth.tenantId, id),
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

// GET /dashboard/tickets/:id/tracking — fresh carrier status for the ticket's
// shipment, fed to the ticket-detail Tracking card. The tracking number comes
// from the order's live fulfillment when present, else the agent's
// `liveTrackingStatus` stamp (`pickTrackingSource` — the fulfillment is the
// canonical record and reflects reships/edits immediately; the stamp is a
// snapshot of the last agent lookup and can describe a superseded number);
// a live 17track lookup (TrackingService) returns the rich result.
// Best-effort: no number → `no_tracking_number`, provider error → `unavailable`
// (the card falls back to the on-ticket stamp).
export const handleDashboardTicketTracking = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const result: TicketTrackingResult = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        const ticketRow = yield* Effect.promise(() =>
          ticketContextForTenant(db, auth.tenantId, id),
        );
        if (!ticketRow) return { kind: "not_found" as const };
        const context = (ticketRow.context ?? {}) as Record<string, unknown>;
        const order = yield* resolveOrderForContext(
          TenantId(auth.tenantId),
          context,
        );
        const source = pickTrackingSource(
          context,
          order?.fulfillments ?? null,
        );
        if (!source) return { kind: "no_tracking_number" as const };
        const trackingSvc = yield* TrackingService;
        const tracking = yield* trackingSvc
          .lookup(TenantId(auth.tenantId), {
            trackingNumber: source.trackingNumber,
            carrier: source.carrier,
          })
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
// pages + the ticket-detail Shopify shop-domain deep link.
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

// GET /dashboard/audit?action=&actor=&page=&limit= — cross-ticket audit log.
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

// POST /dashboard/tickets/:id/approvals/{approve,reject} — decide the WHOLE
// pending bundle for a ticket in one click (autonomous loop, slice 7). The
// scenario agent queues several gated actions on one ticket; this approves (or
// rejects) every pending row, then publishes ONE event so the runtime executes
// the bundle in order (the slice-4d resume contract: all rows decided BEFORE the
// event fires, else a per-row event could resolve the ticket while siblings are
// still pending). `approve` accepts an optional `{ edits: { [approvalId]: input } }`
// so an edited reply draft flows through; `reject` moves no money and takes none.
export const handleDashboardTicketApprovalsBundle =
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
    const { id: ticketId } = req.params as { id: string };
    const managerId = UserId(auth.userId);

    // Every pending row for the ticket, in creation (= proposal) order.
    const pending = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ApprovalService;
          const all = yield* svc.listForTicket(
            TenantId(auth.tenantId),
            TicketId(ticketId),
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
          ticketId: TicketId(ticketId),
          action,
          managerId,
          edits,
        }),
        layer,
      ),
    );

    // Publish ONE event AFTER all rows are decided. The runtime gathers every
    // approved row for the ticket and runs them in order (slice 4d).
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
          { ticketId, cause },
        );
      }
    }

    return sendJson(res, 200, {
      kind: "decided",
      action,
      count: decidedCount,
    });
  };

// POST /dashboard/tickets/:id/takeover — manager takes over a ticket.
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
    takeOverTicket(db, {
      ticketId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "ticket_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/tickets/:id/resume — manager hands a taken-over ticket back
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
    resumeTicket(db, {
      ticketId: id,
      tenantId: auth.tenantId,
      managerId,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "ticket_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/tickets/:id/status — manager manually sets the ticket status
// (e.g. mark resolved, reopen, or park waiting on the customer). The move is
// validated against the ticket state machine (§10) in the same tx that writes
// the transition + audit rows; pending approvals are canceled. Like resume,
// this is a pure DB transition — it does NOT tick the agent (the merchant uses
// "Retry now" for that).
export const handleDashboardSetTicketStatus = async (
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
    setTicketStatus(db, {
      ticketId: id,
      tenantId: auth.tenantId,
      managerId: auth.userId!,
      toStatus,
      reason,
    }),
  );
  const status =
    outcome.kind === "ticket_not_found"
      ? 404
      : outcome.kind === "invalid_status"
        ? 400
        : outcome.kind === "transition_not_allowed"
          ? 409
          : 200; // updated | unchanged
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/resolve — manager closes a ticket by hand, including
// one they've TAKEN OVER ("Resolve" button on the ticket page). Distinct from the
// status endpoint: resolving a `human_takeover` ticket is a legitimate human close
// (the manager owns it and is done), so this goes through the lifecycle bridge
// (`human_takeover → in_progress → resolved`) rather than the forbidden direct
// jump the status endpoint refuses. Gated on the same permission as a manual
// status change.
export const handleDashboardResolveTicket = async (
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
    resolveTicketManually(db, {
      ticketId: id,
      tenantId: auth.tenantId,
      managerId: auth.userId!,
      reason,
    }),
  );
  return sendJson(res, outcome.kind === "ticket_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/tickets/:id/escalate-supplier — manager hands the ticket to the
// workspace's supplier by hand ("Escalate to supplier" in the ticket-page menu).
// Same machinery as the agent's supplier.escalate tool: the escalation row is
// the notify outbox (worker cron emails the supplier), and the ticket parks in
// waiting_for_supplier — bridging from human_takeover, or staying parked on
// approval when that's the primary wait. The problem statement is required:
// it's what the supplier sees in the portal + email. The order projection
// (ref, ship city/country, tracking) is auto-filled from the ticket's
// canonically-bound order — best-effort, so an unreachable Shopify never
// blocks the escalation.
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
  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        const ctx = yield* Effect.promise(() =>
          ticketContextForTenant(db, auth.tenantId, id),
        );
        if (!ctx) return { kind: "ticket_not_found" as const };
        const order = yield* resolveCanonicalOrder(
          TenantId(auth.tenantId),
          (ctx.context ?? {}) as Record<string, unknown>,
        );
        return yield* Effect.promise(() =>
          escalateTicketToSupplier(db, {
            ticketId: id,
            tenantId: auth.tenantId,
            managerId: auth.userId!,
            problem,
            reason,
            ...supplierOrderProjection(order),
          }),
        );
      }),
      layer,
    ),
  );
  const status =
    outcome.kind === "ticket_not_found"
      ? 404
      : outcome.kind === "no_supplier" ||
          outcome.kind === "transition_not_allowed"
        ? 409
        : 200; // escalated | already_escalated
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/details — a manager hand-corrects the customer
// and/or order the agent couldn't extract (the pencil edit on the Customer /
// Order cards). Rarely needed, but it must never leave the manager blocked on a
// ticket: e.g. a legacy relay ticket created before Reply-To parsing landed, stamped
// with `mailer@shopify.com` as the customer. The order ref is resolved to its
// canonical Shopify order HERE (this handler holds ShopifyService) so we stamp
// the same `identifiedOrderId` GID the runtime would — an unresolvable ref is
// still recorded as `quotedOrderRef` so the panel shows the hint. Only the
// provided fields change; no status transition (details are metadata). Gated on
// `tickets.set_status` (the "correct ticket state by hand" permission).
export const handleDashboardEditTicketDetails = async (
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
          editTicketDetails(db, {
            ticketId: id,
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

  if (result.outcome.kind === "ticket_not_found") {
    return sendJson(res, 404, { kind: "ticket_not_found" });
  }
  return sendJson(res, 200, {
    kind: "saved",
    ...(result.orderResolved !== undefined
      ? { orderResolved: result.orderResolved }
      : {}),
    ...(result.orderName ? { orderName: result.orderName } : {}),
  });
};

// POST /dashboard/tickets/:id/shipping-address — a manager fixes the order's
// Ship-to (the pencil on the Order card): the customer typo'd their address
// and wrote in before fulfillment. Unlike the details endpoint (ticket
// metadata), this WRITES TO THE STORE — the ticket's resolved order gets its
// shipping address replaced via Shopify's `orderUpdate`, under operator
// authorization. Fields are three-state: absent = keep the current value,
// blank = clear it, text = replace it (the pencil posts the whole prefilled
// form, so blanking a field clears it and untouched fields carry over).
// The orchestration + merge live in the unit-tested
// `updateTicketShippingAddress` core; this handler wires it to the live
// services and records a `ticket.shipping_address_updated` audit row.
export const handleDashboardEditShippingAddress = async (
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

  // Three-state per field: absent = keep, blank = clear, text = set. The
  // Ship-to pencil posts the whole prefilled form, so blanking a field is how
  // the operator clears it.
  const fields = parseShippingAddressFields(body);

  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(id);
  const userId = auth.userId;

  const ticketRow = await runWithDb(layer, (db) =>
    ticketContextForTenant(db, auth.tenantId, id),
  );
  if (!ticketRow) return sendJson(res, 404, { kind: "ticket_not_found" });
  const context = (ticketRow.context ?? {}) as Record<string, unknown>;

  // Captured by `update` so the audit row can name the order it changed.
  let updatedOrderId: string | null = null;

  const outcome = await updateTicketShippingAddress({
    fields,
    loadOrder: () =>
      Effect.runPromise(
        Effect.provide(
          resolveOrderForContext(tenantId, context).pipe(
            Effect.map((order) =>
              order
                ? {
                    orderId: String(order.id),
                    address: order.shippingAddress,
                  }
                : null,
            ),
            // No creds / revoked connector → the order can't be resolved.
            Effect.catchAll(() => Effect.succeed(null)),
          ),
          layer,
        ),
      ),
    update: async ({ orderId, address }) => {
      updatedOrderId = orderId;
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const shopify = yield* ShopifyService;
            return yield* shopify
              .updateOrderShippingAddress(tenantId, {
                orderId: OrderId(orderId),
                address,
              })
              .pipe(Effect.either);
          }),
          layer,
        ),
      );
      if (result._tag === "Left") {
        const detail = describeShopifyError(result.left);
        req.log.error(
          {
            err: result.left,
            shopifyErrorTag: result.left._tag,
            tenantId,
            orderId,
            ticketId: id,
          },
          `dashboard edit shipping address: Shopify orderUpdate failed — ${detail}`,
        );
        throw new Error(detail);
      }
      return result.right;
    },
    recordUpdated: (address) =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const audit = yield* AuditLogService;
            yield* audit
              .record({
                tenantId,
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.shipping_address_updated",
                details: {
                  ...(updatedOrderId ? { orderId: updatedOrderId } : {}),
                  address,
                  via: "dashboard",
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }),
          layer,
        ),
      ),
  });

  const status =
    outcome.kind === "saved"
      ? 200
      : outcome.kind === "order_not_found"
        ? 404
        : outcome.kind === "update_failed"
          ? 502
          : 400; // nothing_to_update
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/cancel-order — the operator cancels the ticket's
// order from the Order card. Wires `cancelTicketOrder`'s deps to the live
// services and records a `ticket.order_cancelled` audit row. Gated on
// `refunds.issue`: a cancel refunds captured money by default.
export const handleDashboardCancelOrder = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };

  const request = parseCancelOrderBody(parseJsonBody(req));
  if (!request) return sendJson(res, 400, { kind: "invalid_reason" });

  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(id);
  const userId = auth.userId;

  const ticketRow = await runWithDb(layer, (db) =>
    ticketContextForTenant(db, auth.tenantId, id),
  );
  if (!ticketRow) return sendJson(res, 404, { kind: "ticket_not_found" });
  const context = (ticketRow.context ?? {}) as Record<string, unknown>;

  const outcome = await cancelTicketOrder({
    request,
    loadOrder: () =>
      Effect.runPromise(
        Effect.provide(
          resolveOrderForContext(tenantId, context).pipe(
            Effect.map((order) =>
              order
                ? {
                    orderId: String(order.id),
                    cancelledAt: order.cancelledAt
                      ? order.cancelledAt.toISOString()
                      : null,
                  }
                : null,
            ),
            // No creds / revoked connector → the order can't be resolved.
            Effect.catchAll(() => Effect.succeed(null)),
          ),
          layer,
        ),
      ),
    cancel: async ({ orderId, request: r }) => {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const shopify = yield* ShopifyService;
            return yield* shopify
              .cancelOrder(tenantId, {
                orderId: OrderId(orderId),
                reason: r.reason,
                refund: r.refund,
                restock: r.restock,
                // The operator communicates through the ticket — don't have
                // Shopify also email a cancellation notice.
                notifyCustomer: false,
                staffNote: r.staffNote,
                // Stable over (ticket, order) so a double-click or a retried
                // request cannot cancel-and-refund twice.
                idempotencyKey: `dashboard-cancel:${id}:${orderId}`,
              })
              .pipe(Effect.either);
          }),
          layer,
        ),
      );
      if (result._tag === "Left") {
        const detail = describeShopifyError(result.left);
        req.log.error(
          {
            err: result.left,
            shopifyErrorTag: result.left._tag,
            tenantId,
            orderId,
            ticketId: id,
          },
          `dashboard cancel order: Shopify orderCancel failed — ${detail}`,
        );
        throw new Error(detail);
      }
      return { jobId: result.right.jobId, accepted: result.right.accepted };
    },
    recordCancelled: ({ orderId, jobId, request: r }) =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const audit = yield* AuditLogService;
            yield* audit
              .record({
                tenantId,
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.order_cancelled",
                details: {
                  orderId,
                  ...(jobId ? { jobId } : {}),
                  refund: r.refund,
                  restock: r.restock,
                  reason: r.reason,
                  ...(r.staffNote ? { staffNote: r.staffNote } : {}),
                  via: "dashboard",
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          }),
          layer,
        ),
      ),
  });

  const status =
    outcome.kind === "cancelled"
      ? 200
      : outcome.kind === "order_not_found"
        ? 404
        : outcome.kind === "already_cancelled"
          ? 409
          : 502; // cancel_failed
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/retry — manager hands a taken-over ticket back
// AND has the agent try again immediately: the resume flip plus a
// `ticket.resumed` workflow event, so the worker ticks now instead of
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
  const outcome = await retryTicketNow({
    ticketId: id,
    fromTriage,
    // Fresh per click so this restart re-runs the agent's tools instead of
    // deduping against the prior attempt (see deliveryScopeFor / ticket.resumed).
    resumeToken: randomUUID(),
    resume: () =>
      runWithDb(layer, (db) =>
        resumeTicket(db, {
          ticketId: id,
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
  return sendJson(res, outcome.kind === "ticket_not_found" ? 404 : 200, outcome);
};

// POST /dashboard/tickets/:id/retry-send — re-send the SAME drafted customer
// reply whose delivery failed (distinct from /retry, which re-runs the agent).
// Requeues the ticket's reply-delivery outbox row (fresh attempt budget, due
// now); the worker's reply-delivery-retry sweep re-sends it within the minute
// and auto-resolves the ticket on success.
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
    // Tenant-scope the action: the outbox row carries its tenant, so a ticket id
    // from another workspace finds nothing.
    const active = await getActiveReplyDeliveryForTicket(db, id);
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

// POST /dashboard/tickets/:id/reply — a human drafts and sends a customer-facing
// reply directly, while driving the ticket in `human_takeover`. The reply goes
// out on the SAME connector/thread the agent uses (ConversationService.reply),
// so threading stays natural; the ticket stays in `human_takeover` (no
// auto-resolve — the person decides when they're done). The orchestration +
// guards live in the unit-tested `sendManualReply` core; this handler wires it
// to the live services.
export const handleDashboardTicketReply = async (
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
  // Opaque ticket-attachment ids (from the upload endpoint); resolved below
  // strictly within this tenant + ticket. Cap mirrors the ingestion limit.
  const attachmentIds = [...new Set(strList(body, "attachmentIds"))];
  if (attachmentIds.length > 8) {
    return sendJson(res, 400, { error: "too_many_attachments" });
  }
  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(id);
  const userId = auth.userId;
  // One idempotency key for this send; reused if the connector retries
  // internally within the request (master-plan §9).
  const draftId = `manual:${randomUUID()}`;

  // Resolve the live thread to learn who to reply to (the customer) + which
  // message to thread under. Never fails — degrades to a tagged error result
  // the core surfaces as `send_failed`.
  const deliverEffect = (threadId: string, mailbox: string) =>
    Effect.gen(function* () {
      const tickets = yield* TicketRepository;
      const conversation = yield* ConversationService;
      const connectorStore = yield* ConnectorCredentialStore;
      const rawThreadId = parseThreadId(threadId)?.raw ?? threadId;
      const provider =
        parseThreadId(threadId)?.provider ??
        (yield* tickets.findThreadProvider(tenantId, ThreadId(threadId)));
      const connections = yield* connectorStore.listForTenant(tenantId);
      const resolution = yield* resolveTicketConversationThread(
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
      const attachmentStore = yield* TicketAttachmentStore;
      const attachmentRows = yield* attachmentStore
        .getByIds(tenantId, ticketId, attachmentIds)
        .pipe(Effect.orElseSucceed(() => []));
      if (attachmentRows.length !== attachmentIds.length) {
        return { kind: "error" as const, error: "attachment_not_found" };
      }
      // These bytes now belong to an outgoing message — keep the GC sweep off
      // them even if the send below fails and the merchant retries.
      yield* attachmentStore
        .markUsed(tenantId, ticketId, attachmentIds)
        .pipe(Effect.orElseSucceed(() => undefined));
      const sent = yield* conversation
        .reply(tenantId, {
          threadId: ThreadId(threadId),
          mailbox,
          to: [target.to],
          // null → connector inherits the thread subject (`Re: <subject>`).
          subject: null,
          bodyText,
          bodyHtml,
          attachments: attachmentRows.map(toMessageAttachment),
          inReplyToMessageId: target.inReplyToMessageId,
          draftId,
        })
        .pipe(Effect.either);
      if (sent._tag === "Left") {
        return { kind: "error" as const, error: sent.left._tag };
      }
      // Tie the files to the message that carried them so the thread renders
      // them under this reply's bubble. Best-effort — the reply is delivered;
      // bookkeeping must not fail the request.
      yield* attachmentStore
        .bindToMessage(tenantId, ticketId, attachmentIds, sent.right.id)
        .pipe(Effect.orElseSucceed(() => undefined));
      return {
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
    loadTicket: () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tickets = yield* TicketRepository;
            return yield* tickets.getById(ticketId, tenantId).pipe(
              Effect.map(
                (c): ManualReplyTicketView => ({
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
            const tickets = yield* TicketRepository;
            const audit = yield* AuditLogService;
            // Index the outbound message id so the customer's next reply threads
            // back to this ticket (mirrors the runtime's recordOutboundReplyId).
            yield* tickets
              .recordMessageId({
                tenantId,
                ticketId,
                messageId: sent.id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .record({
                tenantId,
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.replied",
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
      : outcome.kind === "ticket_not_found"
        ? 404
        : outcome.kind === "empty_body"
          ? 400
          : outcome.kind === "send_failed"
            ? 502
            : 409; // not_in_takeover | no_thread
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/attachments — raw-bytes upload (the file's own
// Content-Type on the request, filename in ?filename=). Validates against the
// image/pdf allowlist with a magic-byte sniff, stores bytes in BlobStorage,
// and indexes a ticket_attachments row. The response carries the row id — the
// only handle the client ever passes back (reply / approve requests).
export const handleDashboardTicketAttachmentUpload = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 400, { error: "missing_user" });
  const { id } = req.params as { id: string };
  const { filename } = req.query as { filename?: string };
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const validation = validateAttachmentUpload({
    filename,
    contentType: req.headers["content-type"],
    bytes,
  });
  if (!validation.ok) return sendJson(res, 400, { error: validation.error });

  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(id);
  const userId = auth.userId;
  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const ticket = yield* tickets.getById(ticketId, tenantId).pipe(Effect.either);
        if (ticket._tag === "Left") return { kind: "not_found" as const };
        const blob = yield* BlobStorage;
        const store = yield* TicketAttachmentStore;
        const storageKey = uploadStorageKey(
          auth.tenantId,
          id,
          randomUUID(),
          validation.ext,
        );
        yield* blob.put({
          tenantId,
          key: storageKey,
          bytes,
          contentType: validation.contentType,
        });
        const record = yield* store.record({
          tenantId,
          ticketId,
          source: "merchant",
          filename: validation.filename,
          contentType: validation.contentType,
          sizeBytes: bytes.length,
          storageKey,
          uploadedBy: userId,
        });
        return { kind: "ok" as const, record };
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.succeed({ kind: "store_failed" as const, cause }),
        ),
      ),
      layer,
    ),
  );
  if (outcome.kind === "not_found") {
    return sendJson(res, 404, { error: "ticket_not_found" });
  }
  if (outcome.kind === "store_failed") {
    req.log.error({ err: opaqueCause(outcome.cause) }, "attachment upload failed");
    return sendJson(res, 502, { error: "upload_failed" });
  }
  return sendJson(res, 200, { attachment: toAttachmentSummary(outcome.record) });
};

// GET /dashboard/tickets/:id/attachments — the ticket's attachment index
// (merchant + supplier uploads and ingested inbound files), oldest first.
// Backs the composer's picker so a teammate can attach an already-uploaded
// file (e.g. the supplier's label) without re-uploading it.
export const handleDashboardTicketAttachments = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const rows = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const store = yield* TicketAttachmentStore;
        return yield* store.listForTicket(TenantId(auth.tenantId), TicketId(id));
      }).pipe(Effect.orElseSucceed(() => null)),
      layer,
    ),
  );
  if (rows === null) return sendJson(res, 502, { error: "list_failed" });
  return sendJson(res, 200, { attachments: rows.map(toAttachmentSummary) });
};

/**
 * How long a preview URL stays valid. Long enough for the browser to load the
 * image (and for the manager to open the lightbox they just clicked), short
 * enough that a URL copied out of devtools or a proxy log is worthless within
 * minutes. Blobs are fetched by the browser directly; bytes never stream
 * through the API.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * `ticket_attachments.id` is a uuid column, so a non-uuid path segment would
 * reach the cast and surface as a Postgres error (a 502 + an error log line for
 * what is really just an id that resolves to nothing). Shape-check first.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// GET /dashboard/tickets/:id/attachments/:attachmentId/url — a short-lived
// signed URL for one attachment. The id is resolved strictly within
// (tenant, ticket) by the store, so a tampered id can never mint a URL for
// another tenant's — or another ticket's — blob.
//
// NOTE: the signed URL necessarily embeds the object's path (that is what is
// being signed). The invariant is that a storage key is never ACCEPTED from a
// client — ids are the only inbound handle — not that the key is unguessable.
export const handleDashboardTicketAttachmentUrl = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id, attachmentId } = req.params as {
    id: string;
    attachmentId: string;
  };
  if (!UUID_RE.test(attachmentId)) {
    return sendJson(res, 404, { error: "not_found" });
  }
  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(id);
  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tickets = yield* TicketRepository;
        const ticket = yield* tickets
          .getById(ticketId, tenantId)
          .pipe(Effect.either);
        if (ticket._tag === "Left") return { kind: "not_found" as const };
        const store = yield* TicketAttachmentStore;
        const rows = yield* store.getByIds(tenantId, ticketId, [attachmentId]);
        const row = rows[0];
        if (!row) return { kind: "not_found" as const };
        const blob = yield* BlobStorage;
        const url = yield* blob.presignGetUrl(
          row.storageKey,
          ATTACHMENT_URL_TTL_SECONDS,
        );
        return { kind: "ok" as const, url, row };
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.succeed({ kind: "failed" as const, cause }),
        ),
      ),
      layer,
    ),
  );
  if (outcome.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  if (outcome.kind === "failed") {
    req.log.error(
      { err: String(outcome.cause) },
      "attachment url presign failed",
    );
    return sendJson(res, 502, { error: "presign_failed" });
  }
  return sendJson(res, 200, {
    url: outcome.url,
    expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    filename: outcome.row.filename,
    contentType: outcome.row.contentType,
  });
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
  /** Opaque `ticket_attachments` ids the approved draft promised to carry. */
  readonly attachmentIds: ReadonlyArray<string>;
}

export const decodeApprovedReply = (input: unknown): DecodedApprovedReply | null => {
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
    // Ids only — never a raw storage key, and never trusted: they are re-resolved
    // within (tenant, ticket) before the send.
    attachmentIds: Array.isArray(o["attachmentIds"])
      ? o["attachmentIds"].filter((x): x is string => typeof x === "string")
      : [],
  };
};

// POST /dashboard/tickets/:id/resend-approval — resend an approved customer reply
// that was never sent (skipped when the ticket was taken over — audit
// `approval.stale_delivery_skipped`). Re-sends the EXACT approved draft on the
// same thread (idempotent on (mailbox, draftId), so a retry can't double-send);
// the ticket stays in `human_takeover` for the operator. Orchestration + guards
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
  const ticketId = TicketId(id);
  const userId = auth.userId;

  // One tenant-scoped read serves both the status guard and the resurfaceable
  // approval lookup (memoised so the core's two calls don't double-query).
  let detailP: Promise<Awaited<ReturnType<typeof ticketDetail>>> | null = null;
  const loadDetail = () =>
    (detailP ??= runWithDb(layer, (db) => ticketDetail(db, auth.tenantId, id)));

  const deliverEffect = (approvalId: string) =>
    Effect.gen(function* () {
      const approvalsSvc = yield* ApprovalService;
      const tickets = yield* TicketRepository;
      const conversation = yield* ConversationService;
      const approval = yield* approvalsSvc
        .getById(ApprovalId(approvalId), tenantId)
        .pipe(Effect.either);
      if (approval._tag === "Left") {
        return { kind: "error" as const, error: "approval_not_found" };
      }
      const reply = decodeApprovedReply(approval.right.proposedInput);
      if (!reply) return { kind: "error" as const, error: "bad_draft" };
      const ticketRow = yield* tickets.getById(ticketId, tenantId).pipe(Effect.either);
      if (ticketRow._tag === "Left") {
        return { kind: "error" as const, error: "ticket_not_found" };
      }
      const mailbox = ticketRow.right.mailbox;
      if (!mailbox) return { kind: "error" as const, error: "no_mailbox" };
      // The approved draft may have promised files. Re-resolve its ids within
      // (tenant, ticket) — the stored input is not a trust boundary — and send
      // them. Sending the reply WITHOUT them would deliver a message that
      // refers to an attachment the customer never receives.
      const attachmentStore = yield* TicketAttachmentStore;
      const attachmentRows = yield* attachmentStore
        .getByIds(tenantId, ticketId, reply.attachmentIds)
        .pipe(Effect.orElseSucceed(() => []));
      if (attachmentRows.length !== reply.attachmentIds.length) {
        return { kind: "error" as const, error: "attachment_not_found" };
      }
      const sent = yield* conversation
        .reply(tenantId, {
          threadId: ThreadId(reply.threadId),
          mailbox,
          to: reply.to.map((p) => ({ name: p.name, email: p.email })),
          subject: reply.subject,
          bodyText: reply.bodyText,
          bodyHtml: reply.bodyHtml,
          attachments: attachmentRows.map(toMessageAttachment),
          inReplyToMessageId: reply.inReplyToMessageId,
          draftId: reply.draftId,
        })
        .pipe(Effect.either);
      if (sent._tag === "Left") {
        return { kind: "error" as const, error: sent.left._tag };
      }
      yield* attachmentStore
        .markUsed(tenantId, ticketId, reply.attachmentIds)
        .pipe(Effect.orElseSucceed(() => undefined));
      yield* attachmentStore
        .bindToMessage(tenantId, ticketId, reply.attachmentIds, sent.right.id)
        .pipe(Effect.orElseSucceed(() => undefined));
      return {
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
    loadTicketStatus: async () => {
      const detail = await loadDetail();
      return detail ? detail.ticket.status : null;
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
            const tickets = yield* TicketRepository;
            const audit = yield* AuditLogService;
            yield* tickets
              .recordMessageId({
                tenantId,
                ticketId,
                messageId: sent.id,
                direction: "outbound",
              })
              .pipe(Effect.catchAll(() => Effect.void));
            // Retires the "approved but not sent" card (detection keys on this).
            yield* audit
              .record({
                tenantId,
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.approved_reply_resent",
                details: { approvalId, messageId: sent.id },
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* audit
              .record({
                tenantId,
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.replied",
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
      : outcome.kind === "ticket_not_found" || outcome.kind === "nothing_to_resend"
        ? 404
        : outcome.kind === "send_failed"
          ? 502
          : 409; // not_in_takeover
  return sendJson(res, status, outcome);
};

// POST /dashboard/tickets/:id/refund — operator issues an agent-recommended
// refund directly. Route-gated on `refunds.issue` (moving money is its own
// permission, not implied by any `tickets.*`). The agent took PATH B and only
// *recommended* a refund (read-only `refund.recommend`), so there's no approval
// to approve — this runs the equivalent of `refund.create` under operator
// authorization. The orchestration + guards live in the unit-tested
// `issueTicketRefund` core; this handler wires it to the live services: resolve
// the ticket's order (same resolver the panel uses), issue via ShopifyService, and
// record a `ticket.refund_issued` audit row. Works regardless of ticket status, so a
// resolved ticket whose reply already promised the refund can still be paid.
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
  const ticketId = TicketId(id);
  const userId = auth.userId;

  // Tenant-scoped ticket load → context (null = ticket missing / another tenant).
  const ticketRow = await runWithDb(layer, (db) =>
    ticketContextForTenant(db, auth.tenantId, id),
  );
  if (!ticketRow) return sendJson(res, 404, { kind: "ticket_not_found" });
  const context = (ticketRow.context ?? {}) as Record<string, unknown>;

  const outcome = await issueTicketRefund({
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
                note: dashboardRefundNote({ ticketId: id, reason }),
                notifyCustomer: true,
                // Stable over (ticket, order, amount) so a double-click / retry
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
            ticketId: id,
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
                ticketId,
                actor: { type: "user", id: userId },
                action: "ticket.refund_issued",
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

// GET /dashboard/tickets/:id/refund-context — everything the dashboard's
// Shopify-style refund modal needs to render and price a refund: the refundable
// line items (with per-unit pricing from Shopify's own `suggestedRefund`), the
// refundable shipping, the maximum refundable, the payment-method label, and
// the store's stock locations. Route-gated on `refunds.issue` (it's the first
// step of issuing a refund). Resolves the ticket's order with the same resolver
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

  const ticketRow = await runWithDb(layer, (db) =>
    ticketContextForTenant(db, auth.tenantId, id),
  );
  if (!ticketRow) return sendJson(res, 404, { kind: "ticket_not_found" });
  const context = (ticketRow.context ?? {}) as Record<string, unknown>;

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

// POST /dashboard/tickets/:id/block-sender — add THIS ticket's customer email
// to the tenant blocklist (the ⋮ quick action for spammers). The address is
// derived server-side from the ticket's context — a client-posted email is
// never trusted. 409 when the ticket has no usable customer email (the
// operator can set one via the details pencil first).
export const handleDashboardBlockTicketSender = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const { id } = req.params as { id: string };
  const ctx = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* DbClient;
        return yield* Effect.promise(() =>
          ticketContextForTenant(db, auth.tenantId, id),
        );
      }),
      layer,
    ),
  );
  if (!ctx) return sendJson(res, 404, { error: "ticket_not_found" });
  const customerEmail = (ctx.context as Record<string, unknown> | null)?.[
    "customerEmail"
  ];
  const entry =
    typeof customerEmail === "string"
      ? normalizeBlockedSenderInput(customerEmail)
      : null;
  if (!entry || entry.kind !== "email") {
    return sendJson(res, 409, { error: "missing_customer_email" });
  }
  const outcome = await addBlockedSenderEntry(layer, auth.tenantId, entry);
  if (outcome.kind === "list_full") {
    return sendJson(res, 400, { error: "list_full" });
  }
  return sendJson(res, 200, {
    ok: true,
    blocked: entry.value,
    ...(outcome.kind === "already_blocked" ? { alreadyBlocked: true } : {}),
  });
};
