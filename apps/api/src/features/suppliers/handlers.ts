import { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { CaseId, type DomainEvent } from "@support-agent/agent-core";
import { makeEnqueuedWorkflowEvent } from "@support-agent/services";
import {
  createInvitation,
  createSupplier,
  ensureActingOwnerInOpenMode,
  ensureSupplierRole,
  getEscalationForSupplier,
  getSupplierByEmail,
  getSupplierForUser,
  listOpenEscalationsForSupplier,
  recordSupplierUpdate,
} from "@support-agent/db";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";
import { bodyStr, sendJson } from "../../platform/http.js";
import {
  authenticateDashboard,
  getWorkosOrgAdminDirectory,
  runWithDb,
} from "../../auth/dashboard-context.js";
import { resolveInvitationId } from "../../auth/invite-send.js";
import { acquireApprovalBoss } from "../../platform/pgboss.js";

const WORKFLOW_QUEUE = "workflow.events";

/**
 * Publish a supplier.updated event onto the workflow queue so the worker
 * re-engages the agent. Mirrors the approval publisher. By the time this runs
 * the case has already been flipped off waiting_for_supplier (recordSupplierUpdate),
 * so the park guard never holds the very event we mint (flip-then-publish, like
 * retryCaseNow).
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

// GET /dashboard/supplier/cases — open escalations for the logged-in supplier
// (minimal privacy projection). An owner previewing this who isn't a supplier
// resolves to no supplier row → empty list.
export const handleSupplierCases = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const cases = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return [];
    return listOpenEscalationsForSupplier(db, supplier.id);
  });
  return sendJson(res, 200, { cases });
};

// GET /dashboard/supplier/cases/:id — one escalation, minimal projection. 404
// (never 403) when it isn't this supplier's — don't disclose existence.
export const handleSupplierCase = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
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

// POST /dashboard/supplier/cases/:id/update — the closed loop. Record the
// supplier's reply, resolve the escalation, flip the case off
// waiting_for_supplier + audit in ONE tx, then publish supplier.updated.
export const handleSupplierUpdate = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  if (!auth.userId) return sendJson(res, 401, { error: "missing_user" });
  const userId = auth.userId;
  const { id } = req.params as { id: string };
  const note = bodyStr(req, "note");
  if (!note) return sendJson(res, 400, { error: "invalid_request" });
  const proposedResolution = bodyStr(req, "proposedResolution") ?? null;

  const outcome = await runWithDb(layer, async (db) => {
    const supplier = await getSupplierForUser(db, auth.tenantId, userId);
    if (!supplier) return { kind: "no_supplier" as const };
    const result = await recordSupplierUpdate(db, {
      tenantId: auth.tenantId,
      supplierId: supplier.id,
      escalationId: id,
      note,
      proposedResolution,
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

  if (result.resumed) {
    try {
      await publishSupplierUpdate(cfg.databaseUrl, {
        type: "supplier.updated",
        caseId: CaseId(result.caseId),
        payload: {
          supplierId: outcome.supplierId,
          note,
          proposedResolution,
        },
      });
    } catch (cause) {
      // The case is already resumed (in_progress); a lost publish just means the
      // agent re-engages on the next event. Log loudly, don't fail the request.
      console.error("[supplier update] publish failed; case resumed without tick", {
        caseId: result.caseId,
        cause,
      });
      return sendJson(res, 200, { ok: true, resumed: true, ticked: false });
    }
  }
  return sendJson(res, 200, {
    ok: true,
    resumed: result.resumed,
    ticked: result.resumed,
  });
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
    inviterUserId: invitedByUuid,
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
