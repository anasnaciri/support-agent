import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "./client.js";
import { tenants } from "./schema.js";
import type { OnboardingResult } from "@support-agent/dashboard-contracts";
import {
  CaseId,
  TenantId,
  UserId,
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
 * Only acts from `human_takeover`; any other status is a no-op
 * (`not_in_takeover`). Cross-tenant ids surface as `case_not_found`.
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
        reason,
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
