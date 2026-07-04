import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  approvals,
  cases,
  caseSupplierEscalations,
  createSupplier,
  makeDbClient,
  suppliers,
  tenants,
} from "@support-agent/db";
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
  const caseDetails = randomUUID();
  const caseEscalate = randomUUID();
  const caseEscalateApproval = randomUUID();
  const caseEscalateFailed = randomUUID();
  const caseEscalateOther = randomUUID();
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
  const caseContext = (id: string) =>
    raw!.db
      .select({ context: cases.context })
      .from(cases)
      .where(eq(cases.id, id))
      .limit(1)
      .then((r) => r[0]?.context as Record<string, unknown> | undefined);

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
      mkCase(caseDetails, tenantId, "human_takeover"),
      mkCase(caseEscalate, tenantId, "human_takeover"),
      mkCase(caseEscalateApproval, tenantId, "waiting_for_approval"),
      mkCase(caseEscalateFailed, tenantId, "failed"),
      mkCase(caseEscalateOther, otherTenantId, "in_progress"),
    ]);
    // The escalate tests' workspace has a supplier; the OTHER tenant has none
    // (its escalate attempt must surface no_supplier).
    await createSupplier(raw.db, tenantId, {
      name: "Warehouse",
      email: `wh-${tenantId.slice(0, 8)}@example.com`,
    });
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
      await raw.db
        .delete(caseSupplierEscalations)
        .where(sql`${caseSupplierEscalations.tenantId} = ${id}`);
      await raw.db
        .delete(suppliers)
        .where(sql`${suppliers.tenantId} = ${id}`);
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

  it("archive-now archives a resolved case but refuses a live one", async () => {
    if (!raw) return;
    // caseSetStatus is in_progress — archiving a live case is forbidden.
    const early = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "archived",
    });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { kind: string }).kind).toBe(
      "transition_not_allowed",
    );

    await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "resolved",
    });
    const res = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "archived",
      reason: "archive now",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("updated");
    const row = await raw.db
      .select({ status: cases.status, archivedAt: cases.archivedAt })
      .from(cases)
      .where(eq(cases.id, caseSetStatus))
      .limit(1)
      .then((r) => r[0]);
    expect(row?.status).toBe("archived");
    expect(row?.archivedAt).not.toBeNull();

    // Restore for the later tests that expect an in_progress case.
    const reopen = await post(`/dashboard/cases/${caseSetStatus}/status`, {
      status: "in_progress",
    });
    expect(reopen.status).toBe(200);
    expect(await caseStatus(caseSetStatus)).toBe("in_progress");
  });

  it("edit-details stamps a hand-corrected customer email + name into context", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseDetails}/details`, {
      customerEmail: "Jane@Shopper.com",
      customerName: "Jane Shopper",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("saved");
    const ctx = await caseContext(caseDetails);
    expect(ctx?.["customerEmail"]).toBe("jane@shopper.com");
    expect(ctx?.["customerName"]).toBe("Jane Shopper");
    // A details edit never changes the case status.
    expect(await caseStatus(caseDetails)).toBe("human_takeover");
  });

  it("edit-details records an unresolvable order ref as a hint (no Shopify creds)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseDetails}/details`, {
      orderRef: "#1001",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; orderResolved?: boolean };
    expect(body.kind).toBe("saved");
    expect(body.orderResolved).toBe(false);
    const ctx = await caseContext(caseDetails);
    expect(ctx?.["quotedOrderRef"]).toBe("#1001");
    // Unresolved → no canonical GID stamped.
    expect(ctx?.["identifiedOrderId"]).toBeUndefined();
  });

  it("edit-details rejects a malformed email (invalid_email, 400)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseDetails}/details`, {
      customerEmail: "not-an-email",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kind: string }).kind).toBe("invalid_email");
  });

  it("edit-details with no fields is a no-op (nothing_to_update, 400)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseDetails}/details`, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "nothing_to_update",
    );
  });

  it("edit-details 404s for a case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseDetails}/details`,
      { customerEmail: "leak@x.com" },
      dashboardAuthHeaders(
        otherOrgId,
        { "content-type": "application/json" },
        `user_${randomUUID()}`,
      ),
    );
    expect(res.status).toBe(404);
    // The real tenant's case is untouched.
    expect((await caseContext(caseDetails))?.["customerEmail"]).toBe(
      "jane@shopper.com",
    );
  });

  it("shipping-address with no fields is a no-op (nothing_to_update, 400)", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseDetails}/shipping-address`,
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "nothing_to_update",
    );
  });

  it("shipping-address 404s when the case's order can't be resolved (no Shopify creds)", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseDetails}/shipping-address`, {
      address1: "456 New St",
      zip: "11375",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "order_not_found",
    );
  });

  it("shipping-address 404s for a case in another tenant", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseDetails}/shipping-address`,
      { address1: "456 New St" },
      dashboardAuthHeaders(
        otherOrgId,
        { "content-type": "application/json" },
        `user_${randomUUID()}`,
      ),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "case_not_found",
    );
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

  it("resolve 404s for a case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const otherHeaders = dashboardAuthHeaders(
      otherOrgId,
      { "content-type": "application/json" },
      workosUser,
    );
    // caseHt is still human_takeover from the 409 test above.
    const r = await post(
      `/dashboard/cases/${caseHt}/resolve`,
      {},
      otherHeaders,
    );
    expect(r.status).toBe(404);
    expect(await caseStatus(caseHt)).toBe("human_takeover");
  });

  it("resolve closes a TAKEN-OVER case the status endpoint refuses", async () => {
    if (!raw) return;
    // The status endpoint 409s on human_takeover→resolved (test above), but the
    // dedicated resolve endpoint bridges the close legally for a human actor.
    const res = await post(`/dashboard/cases/${caseHt}/resolve`, {
      reason: "manager handled it",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("resolved");
    expect(await caseStatus(caseHt)).toBe("resolved");
  });

  it("escalate-supplier parks a taken-over case + writes the escalation row", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseEscalate}/escalate-supplier`, {
      problem: "Order #1001 lost in transit — please reship",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("escalated");
    // Bridged human_takeover → in_progress → waiting_for_supplier (§10).
    expect(await caseStatus(caseEscalate)).toBe("waiting_for_supplier");
    const rows = await raw.db
      .select()
      .from(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.caseId, caseEscalate));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "open",
      problem: "Order #1001 lost in transit — please reship",
    });
    // The escalation row is the notify outbox — the supplier email cron picks
    // up `notified_at IS NULL` rows, same as an agent escalation.
    expect(rows[0]?.notifiedAt).toBeNull();
  });

  it("escalate-supplier is a no-op while an escalation is already open", async () => {
    if (!raw) return;
    const res = await post(`/dashboard/cases/${caseEscalate}/escalate-supplier`, {
      problem: "duplicate",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "already_escalated",
    );
    const rows = await raw.db
      .select()
      .from(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.caseId, caseEscalate));
    expect(rows).toHaveLength(1);
  });

  it("escalate-supplier keeps waiting_for_approval as the primary status", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseEscalateApproval}/escalate-supplier`,
      { problem: "Confirm replacement stock for order #1002" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("escalated");
    // Approval wins the single primary status under concurrent waits; the open
    // escalation row carries the supplier wait on its own.
    expect(await caseStatus(caseEscalateApproval)).toBe("waiting_for_approval");
    const rows = await raw.db
      .select()
      .from(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.caseId, caseEscalateApproval));
    expect(rows).toHaveLength(1);
  });

  it("escalate-supplier refuses an illegal transition without writing", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseEscalateFailed}/escalate-supplier`,
      { problem: "should not land" },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "transition_not_allowed",
    );
    expect(await caseStatus(caseEscalateFailed)).toBe("failed");
    const rows = await raw.db
      .select()
      .from(caseSupplierEscalations)
      .where(eq(caseSupplierEscalations.caseId, caseEscalateFailed));
    expect(rows).toHaveLength(0);
  });

  it("escalate-supplier 400s on a missing problem statement", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseEscalate}/escalate-supplier`,
      { problem: "   " },
    );
    expect(res.status).toBe(400);
  });

  it("escalate-supplier reports no_supplier when the workspace has none", async () => {
    if (!raw) return;
    const otherHeaders = dashboardAuthHeaders(
      otherOrgId,
      { "content-type": "application/json" },
      workosUser,
    );
    const res = await post(
      `/dashboard/cases/${caseEscalateOther}/escalate-supplier`,
      { problem: "no supplier configured here" },
      otherHeaders,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { kind: string }).kind).toBe("no_supplier");
    expect(await caseStatus(caseEscalateOther)).toBe("in_progress");
  });

  it("escalate-supplier 404s for a case in another tenant (no mutation)", async () => {
    if (!raw) return;
    const res = await post(
      `/dashboard/cases/${caseEscalateOther}/escalate-supplier`,
      { problem: "cross-tenant" },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kind: string }).kind).toBe(
      "case_not_found",
    );
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
