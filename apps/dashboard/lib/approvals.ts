import "server-only";
import { Effect, Layer } from "effect";
import { withAuth } from "@workos-inc/authkit-nextjs";
import {
  applyApprovalDecision,
  decisionToEvent,
  type ApprovalDecisionResult,
} from "@support-agent/services";
import {
  ApprovalServiceLive,
  DbClient,
  DbClientLive,
} from "@support-agent/db";
import { TenantId, UserId } from "@support-agent/agent-core";
import { getTenantId } from "./tenant";
import { publishWorkflowEvent } from "./event-publisher";
import { dashboardUserDecisionUuid } from "./user-id";

// ============================================================
// Dashboard approval decision pipeline
// ============================================================
//
// Server Action helper. Pulls tenant + user from the WorkOS session,
// scopes the decision to the user's tenant (cross-tenant ids surface
// as `approval_not_found` — never disclose existence), publishes the
// resulting workflow event so the worker resumes the case.
//
// The same `applyApprovalDecision` core is shared with apps/api so the
// two surfaces can't drift on idempotency / state-conflict semantics.

// Cached Layer build. Next.js keeps the dashboard process long-lived,
// so building the DbClient + ApprovalServiceLive once and reusing
// avoids spawning a new pg pool per request. Typed loosely because
// downstream we cast at the runPromise call — the precise shape is an
// implementation detail of the underlying Effect plumbing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedLayer: Layer.Layer<any, never, never> | null = null;

const buildLayer = () => {
  if (cachedLayer) return cachedLayer;
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the approval decision pipeline");
  }
  const dbLayer = DbClientLive({ databaseUrl });
  const approvals = ApprovalServiceLive.pipe(Layer.provide(dbLayer));
  cachedLayer = Layer.mergeAll(approvals, dbLayer);
  return cachedLayer;
};

export const decideApprovalFromDashboard = async (
  approvalId: string,
  action: "approve" | "reject",
  opts: { readonly approvedInput?: unknown } = {},
): Promise<ApprovalDecisionResult> => {
  const tenantId = await getTenantId();
  const { user } = await withAuth();
  if (!user) {
    throw new Error("unauthenticated");
  }

  const managerId = UserId(dashboardUserDecisionUuid(user.id));
  // The Effect needs ApprovalService in its env, satisfied by the
  // cached layer below. Casting the layer keeps TypeScript happy
  // without recomputing the precise Layer.Layer<...> shape.
  const eff = applyApprovalDecision({
    approvalId,
    action,
    managerId,
    tenantId: TenantId(tenantId),
    ...(opts.approvedInput !== undefined
      ? { approvedInput: opts.approvedInput }
      : {}),
  }) as unknown as Effect.Effect<ApprovalDecisionResult, never, never>;
  const result: ApprovalDecisionResult = await Effect.runPromise(
    Effect.provide(eff, buildLayer()),
  );

  const event = decisionToEvent(result, action, managerId);
  if (event) {
    try {
      await publishWorkflowEvent(event);
    } catch (cause) {
      // Approval row already decided; the worker just won't pick it
      // up until ops replays. Surface as a thrown error so the action
      // can show a recoverable "decision saved but resume failed" UI.
      // eslint-disable-next-line no-console
      console.error(
        "[dashboard approvals] publish failed; row decided without event",
        { approvalId, cause },
      );
      throw new Error("decision recorded but worker resume failed; please retry");
    }
  }

  return result;
};
