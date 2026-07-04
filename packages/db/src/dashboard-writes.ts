import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { cases, tenants } from "./schema.js";
import type { OnboardingResult } from "@support-agent/dashboard-contracts";
import {
  CaseId,
  TenantId,
  UserId,
  isStatusTransitionAllowed,
  type CaseStatus,
} from "@support-agent/agent-core";
import {
  CaseLifecycleWriter,
  CaseLifecycleWriterLive,
  type LegalAcceptance,
  type ResumeCaseOutcome,
  type SetMerchantStatusOutcome,
  type TakeOverCaseOutcome,
} from "@support-agent/services";
import { ensureOwnerRole } from "./member-rbac-store.js";
import {
  getDefaultSupplier,
  hasOpenEscalationForCase,
  insertEscalation,
} from "./supplier-store.js";
import { ApprovalServiceLive } from "./approval-service-live.js";
import { AuditLogServiceLive } from "./audit-log-live.js";
import { CaseRepositoryLive } from "./case-repository-live.js";
import { DbClient } from "./db-client.js";
import { TransactionRunnerLive } from "./transaction-runner-live.js";

// Write operations backing the dashboard's HTTP API (Path B). Ported from
// the dashboard's lib/case-actions.ts so the api owns the mutation (the
// Workers dashboard can't open a Postgres pool). Case lifecycle writes flow
// through CaseLifecycleWriter so state-machine, audit, and adjacent approval
// cancellation rules stay local to one deep module.

export type TakeOverOutcome = TakeOverCaseOutcome;

export interface TakeOverInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

export type ResumeOutcome = ResumeCaseOutcome;

export interface ResumeInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
  /**
   * Full retry: also rebind the case to support-triage so the next tick
   * re-classifies + re-routes (default = re-run the bound specialist).
   */
  readonly restartFromTriage?: boolean | undefined;
}

const caseLifecycleLayer = (db: DrizzleDb) => {
  const dbLayer = Layer.succeed(DbClient, db);
  const deps = Layer.mergeAll(
    ApprovalServiceLive,
    AuditLogServiceLive,
    CaseRepositoryLive,
    TransactionRunnerLive,
  );
  return Layer.provideMerge(CaseLifecycleWriterLive, deps).pipe(
    Layer.provide(dbLayer),
  );
};

const runCaseLifecycle = <A, E>(
  db: DrizzleDb,
  eff: Effect.Effect<A, E, CaseLifecycleWriter>,
): Promise<A> => Effect.runPromise(Effect.provide(eff, caseLifecycleLayer(db)));

/**
 * Transition a case to `human_takeover`, cancel its pending approvals (so a
 * stale email-link click can't resume it), and write the transition + audit
 * rows in one tx. Cross-tenant ids surface as `case_not_found` (never
 * disclose existence); terminal cases are a no-op.
 */
export const takeOverCase = async (
  db: DrizzleDb,
  input: TakeOverInput,
): Promise<TakeOverOutcome> => {
  const reason = input.reason ?? "manager takeover from dashboard";
  return runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle.takeOver({
        caseId: CaseId(input.caseId),
        tenantId: TenantId(input.tenantId),
        actor: { type: "user", id: input.managerId },
        decidedBy: UserId(input.managerId),
        reason,
      });
    }),
  );
};

/**
 * Hand a `human_takeover` case back to the agent: transition it to
 * `in_progress` and write the transition + audit rows in one tx. The case
 * re-enters automation on its next inbound event — the runtime's takeover
 * guard only holds events while the status is `human_takeover`, so flipping
 * the status is all that's needed (the runtime has no message-history replay,
 * so we deliberately don't re-trigger the agent on the already-seen reply).
 * With `restartFromTriage`, it ALSO rebinds the case to triage and cancels
 * every pending approval (the old route's proposals are stale once the case
 * re-classifies from scratch — mirrors `takeOverCase`); a plain hand-back
 * leaves the bound specialist's pending approvals intact. Only acts from
 * `human_takeover`; any other status is a no-op (`not_in_takeover`).
 * Cross-tenant ids surface as `case_not_found`.
 */
export const resumeCase = async (
  db: DrizzleDb,
  input: ResumeInput,
): Promise<ResumeOutcome> => {
  const reason = input.reason ?? "manager handed the case back from dashboard";
  return runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle.resume({
        caseId: CaseId(input.caseId),
        tenantId: TenantId(input.tenantId),
        actor: { type: "user", id: input.managerId },
        decidedBy: UserId(input.managerId),
        reason,
        restartFromTriage: input.restartFromTriage === true,
      });
    }),
  );
};

export type SetCaseStatusOutcome = SetMerchantStatusOutcome;

export interface SetCaseStatusInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** The status the merchant picked. Validated against the settable set + §10. */
  readonly toStatus: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

/**
 * Manually set a case's status from the dashboard ("change status"). The merchant
 * picks one of the human-settable statuses (`MERCHANT_SETTABLE_STATUSES`) and the
 * move is re-checked against the state machine (§10) under the same tx that
 * writes the transition + audit rows — the manual control NEVER bypasses the
 * guard. Pending approvals are canceled (a manual override is authoritative; a
 * stale approval-link click must not act on a case the manager just re-routed —
 * mirrors `takeOverCase`). Same-status is a no-op (`unchanged`); a target the
 * merchant may not set is `invalid_status`; an illegal transition (e.g.
 * resolved→failed) is `transition_not_allowed`; cross-tenant ids surface as
 * `case_not_found` (never disclose existence).
 */
export const setCaseStatus = async (
  db: DrizzleDb,
  input: SetCaseStatusInput,
): Promise<SetCaseStatusOutcome> => {
  const reason = input.reason ?? "case status changed manually from dashboard";
  return runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle.setMerchantStatus({
        caseId: CaseId(input.caseId),
        tenantId: TenantId(input.tenantId),
        actor: { type: "user", id: input.managerId },
        decidedBy: UserId(input.managerId),
        toStatus: input.toStatus,
        reason,
      });
    }),
  );
};

export type ResolveCaseManuallyOutcome =
  | { readonly kind: "resolved" }
  | { readonly kind: "case_not_found" };

export interface ResolveCaseManuallyInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

/**
 * Resolve a case by an explicit HUMAN action ("Resolve" button on the case
 * page) — including a case the manager has TAKEN OVER. Goes through
 * `CaseLifecycleWriter.resolve` with `bridgeFromHumanTakeover`, which makes the
 * close a legal two-step (`human_takeover → in_progress → resolved`) rather than
 * the forbidden direct `human_takeover → resolved` jump. Crucially this keeps
 * the state machine (§10) and the runtime's takeover race guard untouched: the
 * runtime always short-circuits a `human_takeover` case to `PausedForHumanTakeover`
 * before any status write, and `resolve` only takes the bridge for a `user`
 * actor (the agent-side unverified-mismatch park still blocks an agent close).
 * A case already `resolved` is an idempotent no-op; cross-tenant ids surface as
 * `case_not_found` (never disclose existence).
 */
export const resolveCaseManually = async (
  db: DrizzleDb,
  input: ResolveCaseManuallyInput,
): Promise<ResolveCaseManuallyOutcome> => {
  const reason = input.reason ?? "case resolved manually from dashboard";
  return runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle
        .resolve({
          caseId: CaseId(input.caseId),
          tenantId: TenantId(input.tenantId),
          actor: { type: "user", id: input.managerId },
          reason,
          bridgeFromHumanTakeover: true,
        })
        .pipe(
          Effect.map(() => ({ kind: "resolved" as const })),
          Effect.catchTag("CaseNotFound", () =>
            Effect.succeed({ kind: "case_not_found" as const }),
          ),
        );
    }),
  );
};

export type EscalateCaseToSupplierOutcome =
  | { readonly kind: "escalated"; readonly escalationId: string }
  | { readonly kind: "already_escalated" }
  | { readonly kind: "no_supplier" }
  | { readonly kind: "transition_not_allowed"; readonly fromStatus: string }
  | { readonly kind: "case_not_found" };

export interface EscalateCaseToSupplierInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** What the supplier should do — merchant-typed; shown in the supplier portal + email. */
  readonly problem: string;
  /** Free-text reason saved into the transition + audit details. */
  readonly reason?: string | undefined;
}

/**
 * Escalate a case to the workspace's supplier BY HAND ("Escalate to supplier"
 * in the case-page ⋮ menu). Mirrors the agent's `supplier.escalate` tool path:
 * write the `case_supplier_escalations` row first (the row IS the notify
 * outbox — the worker cron emails the supplier off `notified_at IS NULL`),
 * then park the case through `parkWaitingForSupplierManually` (transition +
 * audit in one tx; bridges from `human_takeover`; a `waiting_for_approval`
 * case keeps approval as its primary status while the open row carries the
 * supplier wait). Parkability is pre-checked so an illegal move (e.g. from a
 * `failed` case) refuses BEFORE the escalation row lands; an already-open
 * escalation is a no-op. Cross-tenant ids surface as `case_not_found`.
 */
export const escalateCaseToSupplier = async (
  db: DrizzleDb,
  input: EscalateCaseToSupplierInput,
): Promise<EscalateCaseToSupplierOutcome> => {
  const row = (
    await db
      .select({ status: cases.status })
      .from(cases)
      .where(
        and(eq(cases.id, input.caseId), eq(cases.tenantId, input.tenantId)),
      )
      .limit(1)
  )[0];
  if (!row) return { kind: "case_not_found" };
  const from = row.status as CaseStatus;
  const parkable =
    from === "human_takeover" ||
    from === "waiting_for_approval" ||
    isStatusTransitionAllowed(from, "waiting_for_supplier");
  if (!parkable) return { kind: "transition_not_allowed", fromStatus: from };
  if (await hasOpenEscalationForCase(db, input.tenantId, input.caseId)) {
    return { kind: "already_escalated" };
  }
  const supplier = await getDefaultSupplier(db, input.tenantId);
  if (!supplier) return { kind: "no_supplier" };

  const { id: escalationId } = await insertEscalation(db, {
    tenantId: input.tenantId,
    caseId: input.caseId,
    supplierId: supplier.id,
    problem: input.problem,
    orderRef: null,
    shipCity: null,
    shipCountry: null,
    trackingNumber: null,
  });

  const reason = input.reason ?? "case escalated to supplier from dashboard";
  const outcome = await runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle.parkWaitingForSupplierManually({
        caseId: CaseId(input.caseId),
        tenantId: TenantId(input.tenantId),
        actor: { type: "user", id: input.managerId },
        reason,
        escalationId,
      });
    }),
  );
  if (outcome.kind === "transition_not_allowed") {
    // Raced past the pre-check (the case moved meanwhile). The open escalation
    // row stays valid — the supplier wait is row-derived.
    return { kind: "transition_not_allowed", fromStatus: outcome.fromStatus };
  }
  return { kind: "escalated", escalationId };
};

export type EditCaseDetailsOutcome =
  | { readonly kind: "saved" }
  | { readonly kind: "case_not_found" };

export interface EditCaseDetailsInput {
  readonly caseId: string;
  readonly tenantId: string;
  readonly managerId: string;
  /** Corrected customer address (already validated + normalized). */
  readonly customerEmail?: string | undefined;
  /** Corrected customer display name. */
  readonly customerName?: string | null | undefined;
  /** Corrected customer phone (fallback identifier for the customer lookup). */
  readonly customerPhone?: string | null | undefined;
  /** Resolved order GID — set only when the merchant's ref resolved in Shopify. */
  readonly identifiedOrderId?: string | undefined;
  /** The raw order ref the merchant typed (untrusted hint). */
  readonly quotedOrderRef?: string | undefined;
}

/**
 * Hand-correct a case's customer/order binding from the case page (the pencil
 * edit on the Customer / Order cards). Merges ONLY the provided fields into
 * `case.context` + writes one `case.details_edited` audit row, in one tx, via
 * `CaseLifecycleWriter.setCaseDetails`. No status change — editing details is
 * metadata, so it works in any status (that's the point: the manager isn't
 * blocked). The order ref is resolved to its canonical GID by the caller (the
 * api handler, which holds ShopifyService) before it reaches here, so this
 * stays inside the canonical-order-binding invariant. Cross-tenant ids surface
 * as `case_not_found` (never disclose existence).
 */
export const editCaseDetails = async (
  db: DrizzleDb,
  input: EditCaseDetailsInput,
): Promise<EditCaseDetailsOutcome> =>
  runCaseLifecycle(
    db,
    Effect.gen(function* () {
      const lifecycle = yield* CaseLifecycleWriter;
      return yield* lifecycle
        .setCaseDetails({
          caseId: CaseId(input.caseId),
          tenantId: TenantId(input.tenantId),
          actor: { type: "user", id: input.managerId },
          ...(input.customerEmail !== undefined
            ? { customerEmail: input.customerEmail }
            : {}),
          ...(input.customerName !== undefined && input.customerName !== null
            ? { customerName: input.customerName }
            : {}),
          ...(input.customerPhone !== undefined && input.customerPhone !== null
            ? { customerPhone: input.customerPhone }
            : {}),
          ...(input.identifiedOrderId !== undefined
            ? { identifiedOrderId: input.identifiedOrderId }
            : {}),
          ...(input.quotedOrderRef !== undefined
            ? { quotedOrderRef: input.quotedOrderRef }
            : {}),
        })
        .pipe(
          Effect.map(() => ({ kind: "saved" as const })),
          Effect.catchTag("CaseNotFound", () =>
            Effect.succeed({ kind: "case_not_found" as const }),
          ),
        );
    }),
  );

/**
 * Self-service FIRST-workspace creation for a signed-in WorkOS org (the
 * onboarding flow). Idempotent by org via the pre-SELECT only — since
 * migration 0020 an org may own many tenant rows (workspaces), so the old
 * unique-index backstop is gone. A two-tab onboarding race can therefore
 * mint two workspaces instead of one; that's harmless (it's just an extra
 * workspace), and deliberate creation goes through `createWorkspaceForOrg`.
 */
export const createTenantForOrg = async (
  db: DrizzleDb,
  input: {
    readonly organizationId: string;
    readonly name: string;
    readonly notificationEmail: string;
    readonly legalAcceptance: LegalAcceptance;
  },
): Promise<OnboardingResult> => {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, input.organizationId))
    .limit(1);
  if (existing[0]) return { tenantId: existing[0].id, alreadyExisted: true };

  const id = randomUUID();
  await db.insert(tenants).values({
    id,
    name: input.name,
    workosOrganizationId: input.organizationId,
    settings: {
      notificationEmail: input.notificationEmail,
      legalAcceptance: input.legalAcceptance,
    },
  });
  // Seed the all-access Owner role so the creator has a role to assign from
  // day one (matches the migration backfill for pre-existing workspaces).
  await ensureOwnerRole(db, id);
  return { tenantId: id, alreadyExisted: false };
};

/**
 * Mint an ADDITIONAL workspace (tenant row) under an existing org.
 * Deliberately NOT idempotent — every call creates a workspace. Legal
 * acceptance is supplied by the caller (the api copies the org's current
 * acceptance; a workspace without one can never pass the connector gates).
 */
export const createWorkspaceForOrg = async (
  db: DrizzleDb,
  input: {
    readonly organizationId: string;
    readonly name: string;
    readonly notificationEmail: string;
    readonly legalAcceptance: LegalAcceptance;
  },
): Promise<{ readonly workspaceId: string }> => {
  const id = randomUUID();
  await db.insert(tenants).values({
    id,
    name: input.name,
    workosOrganizationId: input.organizationId,
    settings: {
      notificationEmail: input.notificationEmail,
      legalAcceptance: input.legalAcceptance,
    },
  });
  await ensureOwnerRole(db, id);
  return { workspaceId: id };
};

/**
 * Rename a workspace, only when the org owns it. Returns false on a
 * foreign/unknown workspace (the api maps that to 404).
 */
export const renameWorkspaceForOrg = async (
  db: DrizzleDb,
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly name: string;
  },
): Promise<boolean> => {
  const rows = await db
    .update(tenants)
    .set({ name: input.name })
    .where(
      and(
        eq(tenants.workosOrganizationId, input.organizationId),
        eq(tenants.id, input.workspaceId),
      ),
    )
    .returning({ id: tenants.id });
  return rows.length > 0;
};
