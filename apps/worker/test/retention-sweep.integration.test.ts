import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApprovalRiskLevel } from "@support-agent/agent-core";
import { TenantRepository } from "@support-agent/services";
import {
  DbClient,
  DbClientLive,
  TenantRepositoryLive,
  approvals,
  auditLog,
  cases,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import {
  computeArchivedDeleteCutoff,
  computeResolvedArchiveCutoff,
  sweepAllTenants,
  sweepTenant,
} from "../src/retention-sweep.js";

// Integration test for the retention sweep cron. Exercises the real
// Postgres retention path:
//   - Resolved case older than 30 days → archived, with audit still retained
//   - Archived case older than 12 months → deleted (+ its audit + approvals)
//   - Unresolved case (in_progress / human_takeover) → kept regardless
//   - Per-tenant scoping: another tenant's cases are NEVER touched

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("retention sweep (Live, integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  // Effect harness: provides DbClient + TenantRepository for the cron.
  // Same composition pattern as agent-runtime-tx.integration.test.ts —
  // build the consumer layer with its dep satisfied, then expose both
  // the consumer and the producer so tests can yield either.
  const dbLayer = DbClientLive({ databaseUrl: databaseUrl! });
  const tenantRepoWithDb = TenantRepositoryLive.pipe(Layer.provide(dbLayer));
  const cronLayer = Layer.mergeAll(tenantRepoWithDb, dbLayer);

  const runLive = <A, E>(eff: Effect.Effect<A, E, DbClient | TenantRepository>) =>
    Effect.runPromise(Effect.provide(eff, cronLayer).pipe(Effect.scoped));

  beforeAll(async () => {
    if (!raw) return;
    await raw.db
      .insert(tenants)
      .values([
        {
          id: tenantA,
          name: "retention-test-A",
          settings: {},
        },
        {
          id: tenantB,
          name: "retention-test-B",
          settings: {},
        },
      ]);
  });

  afterAll(async () => {
    if (!raw) return;
    // FK-safe teardown order.
    await raw.db
      .delete(approvals)
      .where(sql`${approvals.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(cases)
      .where(sql`${cases.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(tenants)
      .where(sql`${tenants.id} IN (${tenantA}, ${tenantB})`);
    await raw.close();
  });

  const seedCase = async (params: {
    readonly tenantId: string;
    readonly status: "resolved" | "archived" | "in_progress" | "human_takeover";
    readonly now: Date;
    readonly resolvedDaysAgo: number | null;
    readonly archivedMonthsAgo?: number | null;
    readonly withApproval?: boolean;
    readonly withAuditEntries?: number;
  }): Promise<string> => {
    if (!raw) throw new Error("no raw client");
    const id = randomUUID();
    const resolvedAt =
      params.resolvedDaysAgo === null
        ? null
        : new Date(
            params.now.getTime() - params.resolvedDaysAgo * 24 * 60 * 60 * 1000,
          );
    const archivedAt =
      params.archivedMonthsAgo === undefined || params.archivedMonthsAgo === null
        ? null
        : new Date(
            Date.UTC(
              params.now.getUTCFullYear(),
              params.now.getUTCMonth() - params.archivedMonthsAgo,
              params.now.getUTCDate(),
              params.now.getUTCHours(),
              params.now.getUTCMinutes(),
              params.now.getUTCSeconds(),
              params.now.getUTCMilliseconds(),
            ),
          );
    await raw.db.insert(cases).values({
      id,
      tenantId: params.tenantId,
      channel: "email",
      currentAgentId: "support-triage",
      status: params.status,
      priority: "normal",
      resolvedAt,
      archivedAt,
    });
    if (params.withAuditEntries && params.withAuditEntries > 0) {
      const rows = Array.from({ length: params.withAuditEntries }, () => ({
        tenantId: params.tenantId,
        caseId: id,
        actorType: "system",
        actorId: "test-seed",
        action: "test.event",
        details: {},
      }));
      await raw.db.insert(auditLog).values(rows);
    }
    if (params.withApproval) {
      await raw.db.insert(approvals).values({
        id: randomUUID(),
        tenantId: params.tenantId,
        caseId: id,
        agentId: "support-triage",
        tool: "conversation.reply",
        proposedInput: {},
        reasoning: "",
        riskLevel: "medium" satisfies ApprovalRiskLevel,
        status: "approved",
        expiresAt: new Date(params.now.getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    }
    return id;
  };

  const countCasesForTenant = async (tenantId: string): Promise<number> => {
    if (!raw) throw new Error("no raw client");
    const rows = await raw.db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.tenantId, tenantId));
    return rows.length;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const waitForBlockedStatement = async (
    patterns: ReadonlyArray<string>,
  ): Promise<void> => {
    if (!raw) throw new Error("no raw client");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      for (const pattern of patterns) {
        const rows = await raw.sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query ILIKE ${pattern}
        `;
        if (Number(rows[0]?.count ?? 0) > 0) return;
      }
      await sleep(25);
    }
    throw new Error(`timed out waiting for blocked statement: ${patterns.join(", ")}`);
  };

  it("archives resolved cases after 30 days without deleting their audit trail", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const oldCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 45, // outside the 30-day window
      now,
      withApproval: true,
      withAuditEntries: 3,
    });
    const recentCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 10, // inside the 30-day window
      now,
      withApproval: false,
      withAuditEntries: 2,
    });
    const openCase = await seedCase({
      tenantId: tenantA,
      status: "in_progress",
      resolvedDaysAgo: null,
      now,
      withApproval: false,
      withAuditEntries: 0,
    });

    const result = await runLive(sweepTenant(tenantA, now));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.archivedCases).toBe(1);
      expect(result.deletedCases).toBe(0);
      expect(result.deletedAuditRows).toBe(0);
      expect(result.deletedApprovals).toBe(0);
      expect(result.archiveCutoff.toISOString()).toBe(
        "2026-04-24T12:00:00.000Z",
      );
    }

    const remaining = await raw.db
      .select({ id: cases.id, status: cases.status, archivedAt: cases.archivedAt })
      .from(cases)
      .where(eq(cases.tenantId, tenantA));
    const byId = new Map(remaining.map((r) => [r.id, r]));
    expect(byId.get(oldCase)?.status).toBe("archived");
    expect(byId.get(oldCase)?.archivedAt?.toISOString()).toBe(now.toISOString());
    expect(byId.get(recentCase)?.status).toBe("resolved");
    expect(byId.get(openCase)?.status).toBe("in_progress");

    const oldAudit = await raw.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.caseId, oldCase));
    expect(oldAudit.length).toBeGreaterThanOrEqual(3);

    // Cleanup for the next test. Archiving no longer deletes approval rows,
    // so they must go first (FK to cases is NO ACTION).
    await raw.db
      .delete(approvals)
      .where(sql`${approvals.tenantId} = ${tenantA}`);
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantA}`);
    await raw.db.delete(cases).where(eq(cases.tenantId, tenantA));
  });

  it("deletes archived cases after 12 months + cascaded audit + approvals", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const oldArchivedCase = await seedCase({
      tenantId: tenantA,
      status: "archived",
      resolvedDaysAgo: 420,
      archivedMonthsAgo: 13,
      now,
      withAuditEntries: 3,
      withApproval: true,
    });
    const recentArchivedCase = await seedCase({
      tenantId: tenantA,
      status: "archived",
      resolvedDaysAgo: 390,
      archivedMonthsAgo: 11,
      now,
      withAuditEntries: 2,
    });

    const result = await runLive(sweepTenant(tenantA, now));
    if (result.kind === "ok") {
      expect(result.deletedCases).toBe(1);
      expect(result.deletedAuditRows).toBe(3);
      expect(result.deletedApprovals).toBe(1);
      expect(result.deleteCutoff.toISOString()).toBe("2025-05-24T12:00:00.000Z");
    }

    const remaining = await raw.db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(eq(cases.tenantId, tenantA));
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(oldArchivedCase);
    expect(ids).toContain(recentArchivedCase);

    // Cleanup
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantA}`);
    await raw.db.delete(cases).where(eq(cases.tenantId, tenantA));
  });

  it("respects per-tenant scoping: tenantB's cases are never touched", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const aCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 60,
      now,
      withAuditEntries: 1,
    });
    const bCase = await seedCase({
      tenantId: tenantB,
      status: "resolved",
      resolvedDaysAgo: 60,
      now,
      withAuditEntries: 1,
    });

    const result = await runLive(sweepTenant(tenantA, now));
    if (result.kind === "ok") {
      expect(result.archivedCases).toBe(1);
      expect(result.deletedCases).toBe(0);
    }

    const aRows = await raw.db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(eq(cases.id, aCase));
    const bRows = await raw.db
      .select({ id: cases.id, status: cases.status })
      .from(cases)
      .where(eq(cases.id, bCase));
    expect(aRows[0]?.status).toBe("archived");
    expect(bRows[0]?.status).toBe("resolved");

    // Cleanup
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} IN (${tenantA}, ${tenantB})`);
    await raw.db
      .delete(cases)
      .where(sql`${cases.tenantId} IN (${tenantA}, ${tenantB})`);
  });

  it("does NOT archive human_takeover cases even when past cutoff", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const takeoverCase = await seedCase({
      tenantId: tenantA,
      status: "human_takeover",
      resolvedDaysAgo: 90, // very old — but status is not resolved
      now,
      withAuditEntries: 1,
    });

    const result = await runLive(sweepTenant(tenantA, now));
    if (result.kind === "ok") {
      expect(result.archivedCases).toBe(0);
      expect(result.deletedCases).toBe(0);
    }
    expect(await countCasesForTenant(tenantA)).toBe(1);

    // Cleanup
    await raw.db.delete(auditLog).where(eq(auditLog.caseId, takeoverCase));
    await raw.db.delete(cases).where(eq(cases.id, takeoverCase));
  });

  it("does not archive a resolved case that reopens while the sweep waits on its row lock", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const reopenedCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 60,
      now,
      withAuditEntries: 1,
    });

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let markLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    const lockStarted = raw.sql.begin(async (tx) => {
      await tx`
        UPDATE cases
        SET status = 'in_progress', updated_at = ${now.toISOString()}, archived_at = NULL
        WHERE id = ${reopenedCase}
      `;
      markLockAcquired();
      await lockReleased;
    });

    await lockAcquired;
    const sweep = runLive(sweepTenant(tenantA, now));
    try {
      await waitForBlockedStatement(['%update "cases"%']);
      releaseLock();
      const result = await sweep;
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.archivedCases).toBe(0);
        expect(result.deletedCases).toBe(0);
      }
      await lockStarted;

      const rows = await raw.db
        .select({ status: cases.status, archivedAt: cases.archivedAt })
        .from(cases)
        .where(eq(cases.id, reopenedCase));
      expect(rows[0]?.status).toBe("in_progress");
      expect(rows[0]?.archivedAt).toBeNull();
    } finally {
      releaseLock();
      await lockStarted.catch(() => undefined);
      await raw.db.delete(auditLog).where(eq(auditLog.caseId, reopenedCase));
      await raw.db.delete(cases).where(eq(cases.id, reopenedCase));
    }
  });

  it("does not delete an archived case that reopens while the sweep waits on its row lock", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    const reopenedCase = await seedCase({
      tenantId: tenantA,
      status: "archived",
      resolvedDaysAgo: 420,
      archivedMonthsAgo: 13,
      now,
      withAuditEntries: 2,
      withApproval: true,
    });

    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let markLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    const lockStarted = raw.sql.begin(async (tx) => {
      await tx`
        UPDATE cases
        SET status = 'in_progress', updated_at = ${now.toISOString()}, archived_at = NULL
        WHERE id = ${reopenedCase}
      `;
      markLockAcquired();
      await lockReleased;
    });

    await lockAcquired;
    const sweep = runLive(sweepTenant(tenantA, now));
    try {
      await waitForBlockedStatement(['%for update%', '%delete from "cases"%']);
      releaseLock();
      const result = await sweep;
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.archivedCases).toBe(0);
        expect(result.deletedCases).toBe(0);
        expect(result.deletedAuditRows).toBe(0);
        expect(result.deletedApprovals).toBe(0);
      }
      await lockStarted;

      const caseRows = await raw.db
        .select({ status: cases.status, archivedAt: cases.archivedAt })
        .from(cases)
        .where(eq(cases.id, reopenedCase));
      expect(caseRows[0]?.status).toBe("in_progress");
      expect(caseRows[0]?.archivedAt).toBeNull();

      const auditRows = await raw.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.caseId, reopenedCase));
      const approvalRows = await raw.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(eq(approvals.caseId, reopenedCase));
      expect(auditRows).toHaveLength(2);
      expect(approvalRows).toHaveLength(1);
    } finally {
      releaseLock();
      await lockStarted.catch(() => undefined);
      await raw.db.delete(approvals).where(eq(approvals.caseId, reopenedCase));
      await raw.db.delete(auditLog).where(eq(auditLog.caseId, reopenedCase));
      await raw.db.delete(cases).where(eq(cases.id, reopenedCase));
    }
  });

  it("sweepAllTenants iterates every tenant with the same archive window", async () => {
    if (!raw) return;
    const now = new Date("2026-05-24T12:00:00.000Z");
    await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 60,
      now,
      withAuditEntries: 1,
    });
    await seedCase({
      tenantId: tenantB,
      status: "resolved",
      resolvedDaysAgo: 60,
      now,
      withAuditEntries: 1,
    });

    const results = await runLive(sweepAllTenants({ now: () => now }));
    // We don't assume only our two tenants exist in the DB — other tests
    // may leave fixture tenants around. Just verify our specific tenants
    // landed in the result with the right counts.
    const a = results.find((r) => r.tenantId === tenantA);
    const b = results.find((r) => r.tenantId === tenantB);
    expect(a?.kind).toBe("ok");
    expect(b?.kind).toBe("ok");
    if (a?.kind === "ok") {
      expect(a.archivedCases).toBe(1);
      expect(a.deletedCases).toBe(0);
    }
    if (b?.kind === "ok") {
      expect(b.archivedCases).toBe(1);
      expect(b.deletedCases).toBe(0);
    }
  });

  // Defensive: assert cutoff math alongside the integration so the
  // Date math the SQL relies on is exercised end-to-end too.
  it("cutoff math matches a known instant", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    expect(computeResolvedArchiveCutoff(now).toISOString()).toBe(
      "2026-04-24T00:00:00.000Z",
    );
    expect(computeArchivedDeleteCutoff(now).toISOString()).toBe(
      "2025-05-24T00:00:00.000Z",
    );
  });
});
