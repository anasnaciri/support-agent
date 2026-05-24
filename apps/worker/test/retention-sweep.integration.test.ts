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
  computeCutoff,
  sweepAllTenants,
  sweepTenant,
} from "../src/retention-sweep.js";

// Integration test for the retention sweep cron. Exercises the real
// Postgres deletion path:
//   - Resolved case past cutoff → deleted (+ its audit + approvals)
//   - Resolved case inside cutoff → kept
//   - Unresolved case (in_progress / human_takeover) → kept regardless
//   - Per-tenant scoping: another tenant's cases are NEVER touched
//   - Missing tenant settings → falls back to DEFAULT_RETENTION_DAYS

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
          settings: { retentionDays: 30 }, // 30-day window for fast assertions
        },
        {
          id: tenantB,
          name: "retention-test-B",
          settings: {}, // no retentionDays → fallback to default (730)
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
    readonly status: "resolved" | "in_progress" | "human_takeover";
    readonly resolvedDaysAgo: number | null;
    readonly withApproval?: boolean;
    readonly withAuditEntries?: number;
  }): Promise<string> => {
    if (!raw) throw new Error("no raw client");
    const id = randomUUID();
    const resolvedAt =
      params.resolvedDaysAgo === null
        ? null
        : new Date(
            Date.now() - params.resolvedDaysAgo * 24 * 60 * 60 * 1000,
          );
    await raw.db.insert(cases).values({
      id,
      tenantId: params.tenantId,
      channel: "email",
      currentAgentId: "support-triage",
      status: params.status,
      priority: "normal",
      resolvedAt,
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
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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

  it("deletes resolved cases past the cutoff + cascaded audit + approvals", async () => {
    if (!raw) return;
    const oldCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 45, // outside the 30-day window
      withApproval: true,
      withAuditEntries: 3,
    });
    const recentCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 10, // inside the 30-day window
      withApproval: false,
      withAuditEntries: 2,
    });
    const openCase = await seedCase({
      tenantId: tenantA,
      status: "in_progress",
      resolvedDaysAgo: null,
      withApproval: false,
      withAuditEntries: 0,
    });

    const result = await runLive(sweepTenant(tenantA, 30, new Date()));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.deletedCases).toBe(1);
      expect(result.deletedAuditRows).toBe(3);
      expect(result.deletedApprovals).toBe(1);
      expect(result.cutoff.getTime()).toBeLessThan(Date.now());
    }

    // Old case gone, recent + open cases still present.
    const remaining = await raw.db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.tenantId, tenantA));
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(oldCase);
    expect(ids).toContain(recentCase);
    expect(ids).toContain(openCase);

    // Cleanup for the next test
    await raw.db
      .delete(auditLog)
      .where(sql`${auditLog.tenantId} = ${tenantA}`);
    await raw.db.delete(cases).where(eq(cases.tenantId, tenantA));
  });

  it("respects per-tenant scoping: tenantB's cases are never touched", async () => {
    if (!raw) return;
    const aCase = await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 60,
      withAuditEntries: 1,
    });
    const bCase = await seedCase({
      tenantId: tenantB,
      status: "resolved",
      resolvedDaysAgo: 60, // also outside if tenantB had 30 days — but tenantB uses default 730
      withAuditEntries: 1,
    });

    const result = await runLive(sweepTenant(tenantA, 30, new Date()));
    if (result.kind === "ok") {
      expect(result.deletedCases).toBe(1);
    }

    expect(await countCasesForTenant(tenantA)).toBe(0);
    expect(await countCasesForTenant(tenantB)).toBe(1);

    // Cleanup
    await raw.db.delete(cases).where(eq(cases.id, bCase));
    await raw.db.delete(auditLog).where(eq(auditLog.caseId, bCase));
    void aCase;
  });

  it("does NOT delete human_takeover cases even when past cutoff", async () => {
    if (!raw) return;
    const takeoverCase = await seedCase({
      tenantId: tenantA,
      status: "human_takeover",
      resolvedDaysAgo: 90, // very old — but status is not resolved
      withAuditEntries: 1,
    });

    const result = await runLive(sweepTenant(tenantA, 30, new Date()));
    if (result.kind === "ok") {
      expect(result.deletedCases).toBe(0);
    }
    expect(await countCasesForTenant(tenantA)).toBe(1);

    // Cleanup
    await raw.db.delete(auditLog).where(eq(auditLog.caseId, takeoverCase));
    await raw.db.delete(cases).where(eq(cases.id, takeoverCase));
  });

  it("sweepAllTenants iterates every tenant and respects per-tenant retentionDays", async () => {
    if (!raw) return;
    // tenantA: 30-day window. Seed a case at 60 days → should be deleted.
    await seedCase({
      tenantId: tenantA,
      status: "resolved",
      resolvedDaysAgo: 60,
      withAuditEntries: 1,
    });
    // tenantB: default 730-day window. Seed a case at 60 days → KEPT.
    await seedCase({
      tenantId: tenantB,
      status: "resolved",
      resolvedDaysAgo: 60,
      withAuditEntries: 1,
    });

    const results = await runLive(sweepAllTenants());
    // We don't assume only our two tenants exist in the DB — other tests
    // may leave fixture tenants around. Just verify our specific tenants
    // landed in the result with the right counts.
    const a = results.find((r) => r.tenantId === tenantA);
    const b = results.find((r) => r.tenantId === tenantB);
    expect(a?.kind).toBe("ok");
    expect(b?.kind).toBe("ok");
    if (a?.kind === "ok") {
      expect(a.retentionDays).toBe(30);
      expect(a.deletedCases).toBe(1);
    }
    if (b?.kind === "ok") {
      expect(b.retentionDays).toBe(730);
      expect(b.deletedCases).toBe(0);
    }
  });

  // Defensive: assert computeCutoff alongside the integration so the
  // Date math the SQL relies on is exercised end-to-end too.
  it("cutoff math matches a known instant", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    expect(computeCutoff(now, 30).toISOString()).toBe(
      "2026-04-24T00:00:00.000Z",
    );
  });

});
