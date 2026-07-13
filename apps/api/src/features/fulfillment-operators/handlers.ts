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
  bindFulfillmentOperatorUserAllTenants,
  ticketContextForTenant,
  createInvitation,
  createFulfillmentOperator,
  ensureActingOwnerInOpenMode,
  ensureFulfillmentOperatorRole,
  getEscalationForFulfillmentOperator,
  getEscalationAttachmentForFulfillmentOperator,
  getMemberAccess,
  getFulfillmentOperatorByEmail,
  getFulfillmentOperatorForUser,
  listOpenEscalationsForFulfillmentOperator,
  listFulfillmentOperatorWorkspacesForUser,
  listTenantsWithPendingFulfillmentOperatorInvitationForEmail,
  reconcileInvitation,
  recordFulfillmentOperatorTrackingUpdate,
  recordFulfillmentOperatorUpdate,
} from "@support-agent/db";
import { resolveOrderForContext } from "../dashboard/shopify-panels.js";
import { describeShopifyError } from "../dashboard/shopify-error-detail.js";
import { updateFulfillmentOperatorTracking } from "./fulfillment-operator-tracking.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { bodyStr, parseJsonBody, sendJson, strList } from "../../platform/http.js";
import {
  toAttachmentSummary,
  uploadStorageKey,
  validateAttachmentUpload,
} from "../dashboard/attachment-upload.js";
import {
  authenticateDashboard,
  authenticateFulfillmentOperator,
  authenticateFulfillmentOperatorIdentity,
  getWorkosDirectory,
  getWorkosOrgAdminDirectory,
  runWithDb,
} from "../../auth/dashboard-context.js";
import { sessionPermissions } from "../../auth/dashboard-authz.js";
import { resolveInvitationId } from "../../auth/invite-send.js";
import { acquireApprovalBoss } from "../../platform/pgboss.js";

const WORKFLOW_QUEUE = "workflow.events";
const ATTACHMENT_URL_TTL_SECONDS = 300;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Publish a `fulfillment_operator.updated` event onto the workflow queue so the worker
 * re-engages the agent. Mirrors the approval publisher. By the time this runs
 * the ticket has already been flipped off waiting_for_fulfillment_operator (recordFulfillmentOperatorUpdate),
 * so the park guard never holds the very event we mint (flip-then-publish, like
 * retryTicketNow).
 */
const publishFulfillmentOperatorUpdate = async (
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

// GET /dashboard/fulfillment-operator/tickets — open escalations for the logged-in fulfillmentOperator
// (minimal privacy projection). Auth is binding-anchored (authenticateFulfillmentOperator):
// a user with no fulfillment partner binding for x-workspace-id is already 404'd, so the
// empty-list branch below only guards a redundant re-lookup.
export const handleFulfillmentOperatorTickets = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const tickets = await runWithDb(layer, async (db) => {
    const fulfillmentOperator = await getFulfillmentOperatorForUser(db, auth.tenantId, userId);
    if (!fulfillmentOperator) return [];
    return listOpenEscalationsForFulfillmentOperator(db, fulfillmentOperator.id);
  });
  return sendJson(res, 200, { tickets });
};

// GET /dashboard/fulfillment-operator/tickets/:id — one escalation, minimal projection. 404
// (never 403) when it isn't this fulfillment partner's — don't disclose existence.
export const handleFulfillmentOperatorTicket = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const detail = await runWithDb(layer, async (db) => {
    const fulfillmentOperator = await getFulfillmentOperatorForUser(db, auth.tenantId, userId);
    if (!fulfillmentOperator) return null;
    return getEscalationForFulfillmentOperator(db, fulfillmentOperator.id, id);
  });
  if (!detail) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, detail);
};

// GET /dashboard/fulfillment-operator/tickets/:id/attachments/:attachmentId/url
// mints a short-lived preview URL only for a customer image forwarded onto
// this escalation.
export const handleFulfillmentOperatorAttachmentUrl = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id, attachmentId } = req.params as {
    id: string;
    attachmentId: string;
  };
  if (!UUID_RE.test(id) || !UUID_RE.test(attachmentId)) {
    return sendJson(res, 404, { error: "not_found" });
  }
  const row = await runWithDb(layer, async (db) => {
    const operator = await getFulfillmentOperatorForUser(
      db,
      auth.tenantId,
      userId,
    );
    if (!operator) return null;
    return getEscalationAttachmentForFulfillmentOperator(
      db,
      operator.id,
      id,
      attachmentId,
    );
  });
  if (!row) return sendJson(res, 404, { error: "not_found" });
  const outcome = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const blob = yield* BlobStorage;
        return yield* blob.presignGetUrl(
          row.storageKey,
          ATTACHMENT_URL_TTL_SECONDS,
        );
      }).pipe(Effect.either),
      layer,
    ),
  );
  if (outcome._tag === "Left") {
    req.log.error(
      { err: String(outcome.left) },
      "fulfillment operator attachment url presign failed",
    );
    return sendJson(res, 502, { error: "presign_failed" });
  }
  return sendJson(res, 200, {
    url: outcome.right,
    expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    filename: row.filename,
    contentType: row.contentType,
  });
};

// POST /dashboard/fulfillment-operator/tickets/:id/update — the closed loop. Record the
// fulfillmentOperator's reply, resolve the escalation, flip the ticket off
// waiting_for_fulfillment_operator + audit in ONE tx, then publish fulfillment_operator.updated.
export const handleFulfillmentOperatorUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const note = bodyStr(req, "note");
  if (!note) return sendJson(res, 400, { error: "invalid_request" });
  const proposedResolution = bodyStr(req, "proposedResolution") ?? null;
  // Ids of files the fulfillment partner uploaded for this update (attachments endpoint).
  const attachmentIds = [...new Set(strList(parseJsonBody(req), "attachmentIds"))];
  if (attachmentIds.length > 8) {
    return sendJson(res, 400, { error: "too_many_attachments" });
  }

  const outcome = await runWithDb(layer, async (db) => {
    const fulfillmentOperator = await getFulfillmentOperatorForUser(db, auth.tenantId, userId);
    if (!fulfillmentOperator) return { kind: "no_fulfillment_operator" as const };
    const result = await recordFulfillmentOperatorUpdate(db, {
      tenantId: auth.tenantId,
      fulfillmentOperatorId: fulfillmentOperator.id,
      escalationId: id,
      note,
      proposedResolution,
      attachmentIds,
      actorUuid: userId,
    });
    return { kind: "recorded" as const, result, fulfillmentOperatorId: fulfillmentOperator.id };
  });

  if (outcome.kind === "no_fulfillment_operator") {
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

  // ALWAYS publish, not just when the status flipped: a fulfillment partner's answer must
  // re-engage the agent even on a ticket that escaped waiting_for_fulfillment_operator (a
  // human resolved / took it over — recordFulfillmentOperatorUpdate flipped it back) or is
  // actively in_progress (no flip needed). A ticket parked waiting_for_approval
  // with an open escalation now REDRAFTS: recordFulfillmentOperatorUpdate supersedes the
  // pending approvals and flips it to in_progress, so the event re-runs the
  // agent (which produces a fresh draft) rather than being held.
  try {
    await publishFulfillmentOperatorUpdate(cfg.databaseUrl, {
      type: "fulfillment_operator.updated",
      ticketId: TicketId(result.ticketId),
      payload: {
        fulfillmentOperatorId: outcome.fulfillmentOperatorId,
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
    console.error("[fulfillment partner update] publish failed; ticket updated without tick", {
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

// POST /dashboard/fulfillment-operator/tickets/:id/attachments — raw-bytes upload scoped to
// the fulfillment partner's OWN OPEN escalation (`:id` = escalation id; 404 for a foreign
// one, 409 once resolved). Same allowlist/sniff/caps as the merchant upload.
// The returned id is what the fulfillment partner's update submission references — the
// agent later forwards the file to the customer via conversation.reply.
export const handleFulfillmentOperatorAttachmentUpload = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
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
    const fulfillmentOperator = await getFulfillmentOperatorForUser(db, auth.tenantId, userId);
    if (!fulfillmentOperator) return null;
    return getEscalationForFulfillmentOperator(db, fulfillmentOperator.id, id);
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
          source: "fulfillment_operator",
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
    req.log.error(
      { err: String(outcome.cause) },
      "fulfillment operator attachment upload failed",
    );
    return sendJson(res, 502, { error: "upload_failed" });
  }
  return sendJson(res, 200, {
    attachment: toAttachmentSummary(outcome.record),
  });
};

// POST /dashboard/fulfillment-operator/tickets/:id/tracking — the fulfillment partner fixes the order's
// tracking number (a reship went out under a new number, or the carrier
// re-labelled the parcel). Unlike the free-text update, this WRITES TO THE
// STORE: the ticket's resolved order gets its fulfillment tracking replaced via
// Shopify's `fulfillmentTrackingInfoUpdate`, under the authenticated
// fulfillmentOperator's authority. It does NOT resolve the escalation — the fulfillment partner
// still posts their update, which is what re-engages the agent. The
// orchestration + fulfillment picking live in the unit-tested
// `updateFulfillmentOperatorTracking` core; this handler owns the authz walls (404 for a
// foreign escalation, 409 once resolved) and wires the live services.
export const handleFulfillmentOperatorTracking = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const trackingNumber = bodyStr(req, "trackingNumber");
  if (!trackingNumber) return sendJson(res, 400, { error: "invalid_request" });
  const trackingCompany = bodyStr(req, "trackingCompany") ?? null;

  // Resolve the escalation through the fulfillment partner binding — a foreign or
  // unknown escalation is a 404 (never 403; don't disclose existence).
  const pre = await runWithDb(layer, async (db) => {
    const fulfillmentOperator = await getFulfillmentOperatorForUser(db, auth.tenantId, userId);
    if (!fulfillmentOperator) return null;
    const escalation = await getEscalationForFulfillmentOperator(db, fulfillmentOperator.id, id);
    if (!escalation) return null;
    const ticketRow = await ticketContextForTenant(
      db,
      auth.tenantId,
      escalation.ticketId,
    );
    return {
      fulfillmentOperatorId: fulfillmentOperator.id,
      escalation,
      context: (ticketRow?.context ?? {}) as Record<string, unknown>,
    };
  });
  if (!pre) return sendJson(res, 404, { error: "not_found" });
  if (pre.escalation.status !== "open") {
    return sendJson(res, 409, { error: "already_resolved" });
  }

  const tenantId = TenantId(auth.tenantId);
  const outcome = await updateFulfillmentOperatorTracking({
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
                // the fulfillment partner posts their update — never a side-channel
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
          `fulfillment operator tracking edit: Shopify fulfillmentTrackingInfoUpdate failed — ${detail}`,
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
        recordFulfillmentOperatorTrackingUpdate(db, {
          tenantId: auth.tenantId,
          fulfillmentOperatorId: pre.fulfillmentOperatorId,
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

// GET /dashboard/fulfillment-operator/workspaces — every merchant workspace the signed-in
// fulfillmentOperator is bound to, ACROSS ALL ORGS, for the portal's workspace switcher.
// Identity-only (no x-workspace-id; the JWT's org is NOT consulted). It also
// idempotently completes the cross-tenant BOOTSTRAP: bind the user to any
// fulfillmentOperator rows matching their VERIFIED email and reconcile pending fulfillmentOperator
// invitations, so a fulfillment partner invited by a new merchant appears here on their
// next load regardless of which org's session they signed into. GET-that-writes,
// mirroring the /dashboard/me/session reconcile precedent; the write is
// idempotent. The email is resolved from WorkOS by the verified `sub` (never the
// spoofable x-user-email header) — a bind grants ticket visibility.
export const handleFulfillmentOperatorWorkspaces = async (
  _cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperatorIdentity(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const userId = auth.userId;
  const directory = getWorkosDirectory(req);
  const email =
    auth.workosUserId && directory
      ? await directory.getEmail(auth.workosUserId)
      : null;
  const workspaces = await runWithDb(layer, async (db) => {
    if (email) {
      await bindFulfillmentOperatorUserAllTenants(db, email, userId);
      const pendingTenants =
        await listTenantsWithPendingFulfillmentOperatorInvitationForEmail(db, email);
      for (const tenantId of pendingTenants) {
        await reconcileInvitation(db, tenantId, {
          email,
          userDecisionUuid: userId,
          ...(auth.workosUserId ? { workosUserId: auth.workosUserId } : {}),
        });
      }
    }
    return listFulfillmentOperatorWorkspacesForUser(db, userId);
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

// GET /dashboard/fulfillment-operator/session — binding-anchored per-workspace permissions
// for the unified switcher. authenticateFulfillmentOperator already validated the binding
// for x-workspace-id (org NOT consulted), so this simply returns the effective
// fulfillmentOperator permissions for that workspace. This is how the SPA loads permissions
// when the ACTIVE workspace is a fulfillment partner one — the merchant POST
// /dashboard/me/session would 404 for a different org's tenant.
export const handleFulfillmentOperatorSession = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateFulfillmentOperator(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  const access = await runWithDb(layer, (db) =>
    getMemberAccess(db, auth.tenantId, auth.userId),
  );
  return sendJson(res, 200, sessionPermissions(access));
};

// POST /dashboard/fulfillment-operator/invite — a merchant (members.manage) invites a
// fulfillmentOperator: ensure the FulfillmentOperator role, create the fulfillment partner entity, and persist a
// pending invitation bound to that role. The WorkOS email send happens
// dashboard-side; the api owns the rows. Auto-claims the inviting merchant as
// Owner first so the first fulfillmentOperator reconcile (which flips the workspace to
// enforced) can't lock the merchant out.
export const handleFulfillmentOperatorInvite = async (
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
  // local-only pending invite that reconciles on the fulfillment partner's verified email.
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
    const roleId = await ensureFulfillmentOperatorRole(db, auth.tenantId);
    const existing = await getFulfillmentOperatorByEmail(db, auth.tenantId, email);
    if (!existing) await createFulfillmentOperator(db, auth.tenantId, { name, email });
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
