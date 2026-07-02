import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  auditLog,
  caseDetail,
  cases,
  makeDbClient,
  tenants,
} from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Verifies the read seam: caseDetail must surface `approvedNotSent` from a real
// `approval.stale_delivery_skipped` audit row + its approval (H9), and drop it
// once a `case.approved_reply_resent` marker exists.
describeIfDb("caseDetail — approvedNotSent (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const tenantId = randomUUID();
  const caseId = randomUUID();
  const approvalId = randomUUID();

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values({ id: tenantId, name: `h9-${tenantId}` });
    await raw.db.insert(cases).values({
      id: caseId,
      tenantId,
      channel: "email",
      status: "human_takeover",
      currentAgentId: "support-triage",
    });
    await raw.db.insert(approvals).values({
      id: approvalId,
      tenantId,
      caseId,
      agentId: "support-triage",
      tool: "conversation.reply",
      proposedInput: { draftId: "d-1", bodyText: "Your order shipped yesterday." },
      riskLevel: "medium",
      status: "approved",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await raw.db.insert(auditLog).values({
      tenantId,
      caseId,
      actorType: "system",
      action: "approval.stale_delivery_skipped",
      details: { approvalId, status: "human_takeover" },
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.db.delete(approvals).where(sql`${approvals.tenantId} = ${tenantId}`);
    await raw.db.delete(cases).where(sql`${cases.tenantId} = ${tenantId}`);
    await raw.db.delete(auditLog).where(sql`${auditLog.tenantId} = ${tenantId}`);
    await raw.db.delete(tenants).where(sql`${tenants.id} = ${tenantId}`);
    await raw.close();
  });

  it("surfaces the approved reply that was skipped on takeover", async () => {
    if (!raw) return;
    const detail = await caseDetail(raw.db, tenantId, caseId);
    expect(detail?.approvedNotSent).not.toBeNull();
    expect(detail?.approvedNotSent?.approvalId).toBe(approvalId);
    expect(detail?.approvedNotSent?.bodyPreview).toBe(
      "Your order shipped yesterday.",
    );
  });

  it("drops it once a resend has been recorded", async () => {
    if (!raw) return;
    await raw.db.insert(auditLog).values({
      tenantId,
      caseId,
      actorType: "user",
      action: "case.approved_reply_resent",
      details: { approvalId, messageId: "msg-1" },
    });
    const detail = await caseDetail(raw.db, tenantId, caseId);
    expect(detail?.approvedNotSent).toBeNull();
  });
});
