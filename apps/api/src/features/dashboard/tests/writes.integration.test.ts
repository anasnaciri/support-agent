import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { approvals, cases, makeDbClient, tenants } from "@support-agent/db";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
  decisionUuidFor,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Path B slice 7 — dashboard write endpoints (approve / reject / takeover).
describeIfDb("apps/api — /dashboard write endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  // The acting user: the api derives the manager decision UUID from the
  // verified `sub`, so we pick a WorkOS user and compute the id it maps to.
  const workosUser = `user_${randomUUID()}`;
  const managerId = decisionUuidFor(workosUser);

  const caseApprove = randomUUID();
  const caseReject = randomUUID();
  const caseTakeover = randomUUID();
  const caseResume = randomUUID();
  const caseRetry = randomUUID();
  const caseSetStatus = randomUUID();
  const caseHt = randomUUID();
  const pApprove = randomUUID();
  const pReject = randomUUID();
  const pCross = randomUUID();
  const pTakeover = randomUUID();
  const pSetStatus = randomUUID();

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "k",
    shopify: {
      clientId: "c",
      clientSecret: "s",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (extra: Record<string, string> = {}) =>
    dashboardAuthHeaders(
      orgId,
      { "content-type": "application/json", ...extra },
      workosUser,
    );
  const post = (
    path: string,
    body: unknown = {},
    h: Record<string, string> = headers(),
  ) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });

  const mkCase = (id: string, owner: string, status: string) => ({
    id,
    tenantId: owner,
    channel: "email",
    status,
    currentAgentId: "support-triage",
  });
  const mkApproval = (id: string, caseId: string, owner: string) => ({
    id,
    tenantId: owner,
    caseId,
    agentId: "refund-review-agent",
    tool: "conversation.reply",
    proposedInput: { bodyText: "original draft" },
    riskLevel: "medium",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  const approvalRow = (id: string) =>
    raw!.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .limit(1)
      .then((r) => r[0]);
  const caseStatus = (id: string) =>
    raw!.db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, id))
      .limit(1)
      .then((r) => r[0]?.status);

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      { id: tenantId, name: "w", workosOrganizationId: orgId },
      { id: otherTenantId, name: "w-other", workosOrganizationId: otherOrgId },
    ]);
    await raw.db.insert(cases).values([
      mkCase(caseApprove, tenantId, "waiting_for_approval"),
      mkCase(caseReject, tenantId, "waiting_for_approval"),
      mkCase(caseTakeover, tenantId, "waiting_for_approval"),
      mkCase(caseResume, tenantId, "human_takeover"),
      mkCase(caseRetry, tenantId, "human_takeover"),
      mkCase(caseSetStatus, tenantId, "waiting_for_approval"),
      mkCase(caseHt, tenantId, "human_takeover"),
    ]);
    await raw.db.insert(approvals).values([
      mkApproval(pApprove, caseApprove, tenantId),
      mkApproval(pReject, caseReject, tenantId),
      mkApproval(pCross, caseApprove, tenantId),
      mkApproval(pTakeover, caseTakeover, tenantId),
      mkApproval(pSetStatus, caseSetStatus, tenantId),
    ]);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const id of [tenantId, otherTenantId]) {
      await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${id}`);
      await raw.db.delete(cases).where(sql`${cases.tenantId} = ${id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await raw.close();
  });

  it("approve marks the row approved with the edited body + manager id", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/approvals/${pApprove}/approve`, {
      approvedInput: { bodyText: "manager edit" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("decided");
    const row = await approvalRow(pApprove);
    expect(row?.status).toBe("approved");
    expect(row?.decidedBy).toBe(managerId);
    expect((row?.approvedInput as { bodyText?: string })?.bodyText).toBe(
      "manager edit",
    );
  });

  it("approving an already-decided row is idempotent", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/approvals/${pApprove}/approve`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "already_decided",
    );
  });

  it("reject marks the row rejected", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/approvals/${pReject}/reject`);
    expect(res.status).toBe(200);
    expect((await approvalRow(pReject))?.status).toBe("rejected");
  });

  it("takeover transitions the case + cancels its pending approvals", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseTakeover}/takeover`, {
      reason: "manual handling",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      canceledApprovals: number;
    };
    expect(body.kind).toBe("taken_over");
    expect(body.canceledApprovals).toBe(1);
    expect(await caseStatus(caseTakeover)).toBe("human_takeover");
    expect((await approvalRow(pTakeover))?.status).toBe("rejected");
  });

  it("resume hands a human_takeover case back to the agent (in_progress)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseResume}/resume`, {
      reason: "handing back to the agent",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; toStatus?: string };
    expect(body.kind).toBe("resumed");
    expect(body.toStatus).toBe("in_progress");
    expect(await caseStatus(caseResume)).toBe("in_progress");
  });

  it("resuming a case that isn't in human_takeover is a no-op", async () => {
    if (!raw) return;
    // caseResume is now in_progress from the previous test.
    const res = await post(`/dashboard/cases/${caseResume}/resume`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status?: string };
    expect(body.kind).toBe("not_in_takeover");
    expect(body.status).toBe("in_progress");
    expect(await caseStatus(caseResume)).toBe("in_progress");
  });

  it("retry hands the case back AND enqueues a case.resumed tick", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseRetry}/retry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; toStatus?: string };
    expect(body.kind).toBe("retried");
    expect(body.toStatus).toBe("in_progress");
    expect(await caseStatus(caseRetry)).toBe("in_progress");
    // The worker-facing event actually landed on workflow.events.
    const jobs = await raw.db.execute(
      sql`select count(*)::int as n from pgboss.job
          where name = 'workflow.events'
            and data->'event'->>'type' = 'case.resumed'
            and data->'event'->>'caseId' = ${caseRetry}`,
    );
    expect((jobs as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  it("retrying a case that isn't in human_takeover is a no-op (no event)", async () => {
    if (!raw) return;
    // caseRetry is now in_progress from the previous test.
    const res = await post(`/dashboard/cases/${caseRetry}/retry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; status?: string };
    expect(body.kind).toBe("not_in_takeover");
    expect(body.status).toBe("in_progress");
    const jobs = await raw.db.execute(
      sql`select count(*)::int as n from pgboss.job
          where name = 'workflow.events'
            and data->'event'->>'type' = 'case.resumed'
            and data->'event'->>'caseId' = ${caseRetry}`,
    );
    expect((jobs as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  it("set-status manually resolves a case + cancels its pending approval", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "resolved",
      reason: "handled offline",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      toStatus?: string;
      canceledApprovals?: number;
    };
    expect(body.kind).toBe("updated");
    expect(body.toStatus).toBe("resolved");
    expect(body.canceledApprovals).toBe(1);
    expect(await caseStatus(caseSetStatus)).toBe("resolved");
    expect((await approvalRow(pSetStatus))?.status).toBe("rejected");
  });

  it("set-status reopens a resolved case to in_progress", async () => {
    if (!raw) return;
    // caseSetStatus is resolved from the previous test.
    const res = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "in_progress",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("updated");
    expect(await caseStatus(caseSetStatus)).toBe("in_progress");
  });

  it("setting the same status is a no-op (unchanged, no mutation)", async () => {
    if (!raw) return;
    // caseSetStatus is in_progress from the previous test.
    const res = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "in_progress",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("unchanged");
    expect(await caseStatus(caseSetStatus)).toBe("in_progress");
  });

  it("rejects a status the merchant may not set (invalid_status, 400)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "triaging",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "invalid_status",
    );
    // unchanged — an agent-internal status can't be forced by hand.
    expect(await caseStatus(caseSetStatus)).toBe("in_progress");
  });

  it("refuses an illegal transition the state machine forbids (409)", async () => {
    if (!raw) return;
    // §10: a human_takeover case can't be marked resolved directly.
    const res = await post(`/dashboard/cases/${caseHt}/status`, {
      status: "resolved",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kind: string; toStatus?: string };
    expect(body.kind).toBe("transition_not_allowed");
    expect(await caseStatus(caseHt)).toBe("human_takeover");
  });

  it("set-status 404s for a case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const otherHeaders = dashboardAuthHeaders(
      otherOrgId,
      { "content-type": "application/json" },
      workosUser,
    );
    const r = await post(
      `/dashboard/cases/${caseSetStatus}/status`,
      { status: "resolved" },
      otherHeaders,
    );
    expect(r.status).toBe(404);
    expect(await caseStatus(caseSetStatus)).toBe("in_progress");
  });

  it("resume 404s for a case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const otherHeaders = dashboardAuthHeaders(
      otherOrgId,
      { "content-type": "application/json" },
      workosUser,
    );
    const r = await post(
      `/dashboard/cases/${caseResume}/resume`,
      {},
      otherHeaders,
    );
    expect(r.status).toBe(404);
  });

  it("401 when the request carries no verified token (write refused)", async () => {
    if (!raw) return;
    // S14: identity comes only from the verified JWT — an unauthenticated write
    // can't be attributed to anyone, so it's refused before any mutation.
    const res = await post(
      `/dashboard/approvals/${pCross}/approve`,
      {},
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(401);
    // unchanged
    expect((await approvalRow(pCross))?.status).toBe("pending");
  });

  it("404 for an approval / case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const otherHeaders = dashboardAuthHeaders(
      otherOrgId,
      { "content-type": "application/json" },
      workosUser,
    );
    const a = await post(`/dashboard/approvals/${pCross}/approve`, {}, otherHeaders);
    expect(a.status).toBe(404);
    expect((await approvalRow(pCross))?.status).toBe("pending");

    const t = await post(`/dashboard/cases/${caseApprove}/takeover`, {}, otherHeaders);
    expect(t.status).toBe(404);
  });
});
