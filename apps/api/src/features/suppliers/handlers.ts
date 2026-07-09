import { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { TicketId, TenantId, type DomainEvent } from "@support-agent/agent-core";
import {
  BlobStorage,
  ShopifyService,
  TicketAttachmentStore,
  makeEnqueuedWorkflowEvent,
} from "@support-agent/services";
import {
  bindSupplierUserAllTenants,
  ticketContextForTenant,
  createInvitation,
  createSupplier,
  ensureActingOwnerInOpenMode,
  ensureSupplierRole,
  getEscalationForSupplier,
  getMemberAccess,
  getSupplierByEmail,
  getSupplierForUser,
  listOpenEscalationsForSupplier,
  listSupplierWorkspacesForUser,
  listTenantsWithPendingSupplierInvitationForEmail,
  reconcileInvitation,
  recordSupplierTrackingUpdate,
  recordSupplierUpdate,
} from "@support-agent/db";
import { resolveOrderForContext } from "../dashboard/shopify-panels.js";
import { describeShopifyError } from "../dashboard/shopify-error-detail.js";
import { updateSupplierTracking } from "./supplier-tracking.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { bodyStr, parseJsonBody, sendJson, strList } from "../../platform/http.js";
import {
  toAttachmentSummary,
  uploadStorageKey,
  validateAttachmentUpload,
} from "../dashboard/attachment-upload.js";
import {
  authenticateDashboard,
  authenticateSupplier,
  authenticateSupplierIdentity,
  getWorkosDirectory,
  getWorkosOrgAdminDirectory,
  runWithDb,
} from "../../auth/dashboard-context.js";
import { sessionPermissions } from "../../auth/dashboard-authz.js";
import { resolveInvitationId } from "../../auth/invite-send.js";
import { acquireApprovalBoss } from "../../platform/pgboss.js";

const WORKFLOW_QUEUE = "workflow.events";

/**
 * Publish a supplier.updated event onto the workflow queue so the worker
 * re-engages the agent. Mirrors the approval publisher. By the time this runs
 * the ticket has already been flipped off waiting_for_supplier (recordSupplierUpdate),
 * so the park guard never holds the very event we mint (flip-then-publish, like
 * retryTicketNow).
 */
const publishSupplierUpdate = async (
  databaseUrl: string,
  event: DomainEvent,
): Promise<void> => {
  const boss = await acquireApprovalBoss(databaseUrl);
  const enqueued = makeEnqueuedWorkflowEvent(event, { eventId: randomUUID() });
  await boss.send(
    WORKFLOW_QUEUE,
    {
      eventId: enqueued.eventId,
      event: enqueued.event,
      key: enqueued.key,
      enqueuedAt: enqueued.enqueuedAt.toISOString(),
    },
    { singletonKey: enqueued.key },
  );
};

// GET /dashboard/supplier/tickets — open escalations for the logged-in supplier
// (minimal privacy projection). Auth is binding-anchored (authenticateSupplier):
// a user with no supplier binding for x-workspace-id is already 404'd, so the
// empty-list branch below only guards a redundant re-lookup.
export const handleSupplierTickets = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const tickets = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return [];
    return listOpenEscalationsForSupplier(db, supplier.id);
  });
  return sendJson(res, 200, { tickets });
};

// GET /dashboard/supplier/tickets/:id — one escalation, minimal projection. 404
// (never 403) when it isn't this supplier's — don't disclose existence.
export const handleSupplierTicket = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const detail = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return null;
    return getEscalationForSupplier(db, supplier.id, id);
  });
  if (!detail) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, detail);
};

// POST /dashboard/supplier/tickets/:id/update — the closed loop. Record the
// supplier's reply, resolve the escalation, flip the ticket off
// waiting_for_supplier + audit in ONE tx, then publish supplier.updated.
export const handleSupplierUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const note = bodyStr(req, "note");
  if (!note) return sendJson(res, 400, { error: "invalid_request" });
  const proposedResolution = bodyStr(req, "proposedResolution") ?? null;
  // Ids of files the supplier uploaded for this update (attachments endpoint).
  const attachmentIds = [...new Set(strList(parseJsonBody(req), "attachmentIds"))];
  if (attachmentIds.length > 8) {
    return sendJson(res, 400, { error: "too_many_attachments" });
  }

  const outcome = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return { kind: "no_supplier" as const };
    const result = await recordSupplierUpdate(db, {
      tenantId: auth.tenantId,
      supplierId: supplier.id,
      escalationId: id,
      note,
      proposedResolution,
      attachmentIds,
      actorUuid: userId,
    });
    return { kind: "recorded" as const, result, supplierId: supplier.id };
  });

  if (outcome.kind === "no_supplier") {
    return sendJson(res, 404, { error: "not_found" });
  }
  const result = outcome.result;
  if (result.kind === "not_found") {
    return sendJson(res, 404, { error: "not_found" });
  }
  if (result.kind === "already_resolved") {
    return sendJson(res, 409, { error: "already_resolved" });
  }
  if (result.kind === "attachment_not_found") {
    return sendJson(res, 400, { error: "attachment_not_found" });
  }

  // ALWAYS publish, not just when the status flipped: a supplier's answer must
  // re-engage the agent even on a ticket that escaped waiting_for_supplier (a
  // human resolved / took it over — recordSupplierUpdate flipped it back) or is
  // actively in_progress (no flip needed). A ticket parked waiting_for_approval
  // with an open escalation now REDRAFTS: recordSupplierUpdate supersedes the
  // pending approvals and flips it to in_progress, so the event re-runs the
  // agent (which produces a fresh draft) rather than being held.
  try {
    await publishSupplierUpdate(cfg.databaseUrl, {
      type: "supplier.updated",
      ticketId: TicketId(result.ticketId),
      payload: {
        supplierId: outcome.supplierId,
        note,
        proposedResolution,
        ...(result.attachments.length > 0
          ? { attachments: result.attachments }
          : {}),
        escalationId: id,
      },
    });
  } catch (cause) {
    // The update is durably recorded (and any flip committed); a lost publish
    // just means the agent re-engages on the next event. Log loudly, don't
    // fail the request.
    console.error("[supplier update] publish failed; ticket updated without tick", {
      ticketId: result.ticketId,
      cause,
    });
    return sendJson(res, 200, {
      ok: true,
      resumed: result.resumed,
      ticked: false,
    });
  }
  return sendJson(res, 200, {
    ok: true,
    resumed: result.resumed,
    ticked: true,
  });
};

// POST /dashboard/supplier/tickets/:id/attachments — raw-bytes upload scoped to
// the supplier's OWN OPEN escalation (`:id` = escalation id; 404 for a foreign
// one, 409 once resolved). Same allowlist/sniff/caps as the merchant upload.
// The returned id is what the supplier's update submission references — the
// agent later forwards the file to the customer via conversation.reply.
export const handleSupplierAttachmentUpload = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const { filename } = req.query as { filename?: string };
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const validation = validateAttachmentUpload({
    filename,
    contentType: req.headers["content-type"],
    bytes,
  });
  if (!validation.ok) return sendJson(res, 400, { error: validation.error });

  const escalation = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return null;
    return getEscalationForSupplier(db, supplier.id, id);
  });
  if (!escalation) return sendJson(res, 404, { error: "not_found" });
  if (escalation.status !== "open") {
    return sendJson(res, 409, { error: "already_resolved" });
  }

  const tenantId = TenantId(auth.tenantId);
  const ticketId = TicketId(escalation.ticketId);
  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const blob = yield* BlobStorage;
        const store = yield* TicketAttachmentStore;
        const storageKey = uploadStorageKey(
          auth.tenantId,
          escalation.ticketId,
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
          source: "supplier",
          filename: validation.filename,
          contentType: validation.contentType,
          sizeBytes: bytes.length,
          storageKey,
          uploadedBy: userId,
          // Binds the file to THIS escalation: the update's id validation and
          // the portal's "files you sent" view are both escalation-scoped.
          escalationId: escalation.id,
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
  if (outcome.kind === "store_failed") {
    req.log.error({ err: String(outcome.cause) }, "supplier attachment upload failed");
    return sendJson(res, 502, { error: "upload_failed" });
  }
  return sendJson(res, 200, {
    attachment: toAttachmentSummary(outcome.record),
  });
};

// POST /dashboard/supplier/tickets/:id/tracking — the supplier fixes the order's
// tracking number (a reship went out under a new number, or the carrier
// re-labelled the parcel). Unlike the free-text update, this WRITES TO THE
// STORE: the ticket's resolved order gets its fulfillment tracking replaced via
// Shopify's `fulfillmentTrackingInfoUpdate`, under the authenticated
// supplier's authority. It does NOT resolve the escalation — the supplier
// still posts their update, which is what re-engages the agent. The
// orchestration + fulfillment picking live in the unit-tested
// `updateSupplierTracking` core; this handler owns the authz walls (404 for a
// foreign escalation, 409 once resolved) and wires the live services.
export const handleSupplierTracking = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const trackingNumber = bodyStr(req, "trackingNumber");
  if (!trackingNumber) return sendJson(res, 400, { error: "invalid_request" });
  const trackingCompany = bodyStr(req, "trackingCompany") ?? null;

  // Resolve the escalation through the supplier binding — a foreign or
  // unknown escalation is a 404 (never 403; don't disclose existence).
  const pre = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return null;
    const escalation = await getEscalationForSupplier(db, supplier.id, id);
    if (!escalation) return null;
    const ticketRow = await ticketContextForTenant(
      db,
      auth.tenantId,
      escalation.ticketId,
    );
    return {
      supplierId: supplier.id,
      escalation,
      context: (ticketRow?.context ?? {}) as Record<string, unknown>,
    };
  });
  if (!pre) return sendJson(res, 404, { error: "not_found" });
  if (pre.escalation.status !== "open") {
    return sendJson(res, 409, { error: "already_resolved" });
  }

  const tenantId = TenantId(auth.tenantId);
  const outcome = await updateSupplierTracking({
    trackingNumber,
    trackingCompany,
    currentTrackingNumber: pre.escalation.trackingNumber,
    loadFulfillments: () =>
      Effect.runPromise(
        Effect.provide(
          resolveOrderForContext(tenantId, pre.context).pipe(
            Effect.map((order) =>
              order
                ? order.fulfillments.map((f) => ({
                    id: f.id,
                    trackingNumbers: f.trackingNumbers,
                    trackingCompany: f.trackingCompany,
                  }))
                : null,
            ),
          ),
          layer,
        ),
      ),
    update: async (args) => {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const shopify = yield* ShopifyService;
            return yield* shopify
              .updateFulfillmentTracking(tenantId, {
                fulfillmentId: args.fulfillmentId,
                trackingNumber: args.trackingNumber,
                trackingCompany: args.trackingCompany,
                // Customer communication goes through the agent's reply once
                // the supplier posts their update — never a side-channel
                // Shopify shipping-update email.
                notifyCustomer: false,
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
            escalationId: id,
            fulfillmentId: args.fulfillmentId,
          },
          `supplier tracking edit: Shopify fulfillmentTrackingInfoUpdate failed — ${detail}`,
        );
        throw new Error(detail);
      }
      return {
        trackingNumbers: result.right.trackingNumbers,
        trackingCompany: result.right.trackingCompany,
      };
    },
    recordUpdated: (args) =>
      runWithDb(layer, (db) =>
        recordSupplierTrackingUpdate(db, {
          tenantId: auth.tenantId,
          supplierId: pre.supplierId,
          escalationId: id,
          actorUuid: userId,
          fulfillmentId: args.fulfillmentId,
          previousTrackingNumber: pre.escalation.trackingNumber,
          trackingNumber: args.trackingNumber,
          trackingCompany: args.trackingCompany,
        }),
      ),
  });

  // 409 for every "can't act on this order" outcome — the escalation itself
  // was found (that wall already returned 404 above); the body's `kind` tells
  // the portal which friendly message to show.
  const status =
    outcome.kind === "saved"
      ? 200
      : outcome.kind === "update_failed" ||
          outcome.kind === "shopify_permission_required"
        ? 502
        : 409;
  return sendJson(
    res,
    status,
    outcome.kind === "saved" ? { ok: true, ...outcome } : outcome,
  );
};

// GET /dashboard/supplier/workspaces — every merchant workspace the signed-in
// supplier is bound to, ACROSS ALL ORGS, for the portal's workspace switcher.
// Identity-only (no x-workspace-id; the JWT's org is NOT consulted). It also
// idempotently completes the cross-tenant BOOTSTRAP: bind the user to any
// supplier rows matching their VERIFIED email and reconcile pending supplier
// invitations, so a supplier invited by a new merchant appears here on their
// next load regardless of which org's session they signed into. GET-that-writes,
// mirroring the /dashboard/me/session reconcile precedent; the write is
// idempotent. The email is resolved from WorkOS by the verified `sub` (never the
// spoofable x-user-email header) — a bind grants ticket visibility.
export const handleSupplierWorkspaces = async (
  _cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplierIdentity(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const userId = auth.userId;
  const directory = getWorkosDirectory(req);
  const email =
    auth.workosUserId && directory
      ? await directory.getEmail(auth.workosUserId)
      : null;
  const workspaces = await runWithDb(layer, async (db) => {
    if (email) {
      await bindSupplierUserAllTenants(db, email, userId);
      const pendingTenants =
        await listTenantsWithPendingSupplierInvitationForEmail(db, email);
      for (const tenantId of pendingTenants) {
        await reconcileInvitation(db, tenantId, {
          email,
          userDecisionUuid: userId,
          ...(auth.workosUserId ? { workosUserId: auth.workosUserId } : {}),
        });
      }
    }
    return listSupplierWorkspacesForUser(db, userId);
  });
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

// GET /dashboard/supplier/session — binding-anchored per-workspace permissions
// for the unified switcher. authenticateSupplier already validated the binding
// for x-workspace-id (org NOT consulted), so this simply returns the effective
// supplier permissions for that workspace. This is how the SPA loads permissions
// when the ACTIVE workspace is a supplier one — the merchant POST
// /dashboard/me/session would 404 for a different org's tenant.
export const handleSupplierSession = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateSupplier(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  return sendJson(res, 200, sessionPermissions(access));
};

// POST /dashboard/supplier/invite — a merchant (members.manage) invites a
// supplier: ensure the Supplier role, create the supplier entity, and persist a
// pending invitation bound to that role. The WorkOS email send happens
// dashboard-side; the api owns the rows. Auto-claims the inviting merchant as
// Owner first so the first supplier reconcile (which flips the workspace to
// enforced) can't lock the merchant out.
export const handleSupplierInvite = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId || !auth.userEmail) {
    return sendJson(res, 400, { error: "missing_user" });
  }
  const invitedByUuid = auth.userId;
  const actingEmail = auth.userEmail;
  const email = bodyStr(req, "email");
  if (!email) return sendJson(res, 400, { error: "invalid_request" });
  const name = bodyStr(req, "name") ?? email;
  // Caller-minted id (Next) is used as-is; otherwise the api sends the WorkOS
  // invitation itself (the SPA has no WORKOS_API_KEY), falling back to a
  // local-only pending invite that reconciles on the supplier's verified email.
  const workosInvitationId = await resolveInvitationId({
    provided: bodyStr(req, "workosInvitationId"),
    adminDir: getWorkosOrgAdminDirectory(req),
    email,
    organizationId: auth.organizationId,
    // WorkOS needs the inviter's WorkOS user id (`sub`), not our decision UUID.
    ...(auth.workosUserId !== undefined
      ? { inviterUserId: auth.workosUserId }
      : {}),
  });

  const result = await runWithDb(layer, async (db) => {
    await ensureActingOwnerInOpenMode(
      db,
      auth.tenantId,
      invitedByUuid,
      actingEmail,
    );
    const roleId = await ensureSupplierRole(db, auth.tenantId);
    const existing = await getSupplierByEmail(db, auth.tenantId, email);
    if (!existing) await createSupplier(db, auth.tenantId, { name, email });
    return createInvitation(db, auth.tenantId, {
      email,
      roleId,
      invitedByUuid,
      ...(workosInvitationId ? { workosInvitationId } : {}),
    });
  });
  if (!result.ok) {
    const status = result.reason === "role_not_found" ? 404 : 409;
    return sendJson(res, status, { error: result.reason });
  }
  return sendJson(res, 200, { invitationId: result.invitationId });
};
