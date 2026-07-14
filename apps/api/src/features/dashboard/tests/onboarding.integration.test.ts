import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeDbClient, tenants } from "@support-agent/db";
import { freshOnboardingState } from "@support-agent/services";
import { startServer, type ServerHandle } from "../../../server.js";
import {
  TEST_DASHBOARD_VERIFIER,
  dashboardAuthHeaders,
} from "../../../tests/support/dashboard-auth.js";
import type { ApiConfig } from "../../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("apps/api — /dashboard/onboarding endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const legacyOrgId = `org_${randomUUID().slice(0, 8)}`;
  const otherOrgId = `org_${randomUUID().slice(0, 8)}`;
  // A workspace created since the wizard shipped: stamped pending.
  const tenantId = randomUUID();
  // A workspace that predates the wizard: no `onboarding` key at all.
  const legacyTenantId = randomUUID();
  const otherTenantId = randomUUID();

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
    google: {
      clientId: "google-client",
      clientSecret: "google-secret",
      callbackUrl: "http://localhost/google/auth/callback",
      pubsubTopic: null,
      pushToken: null,
    },
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: null,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";

  const headers = (org: string) =>
    dashboardAuthHeaders(org, { "content-type": "application/json" });
  const get = (path: string, org = orgId) =>
    fetch(`${baseUrl}${path}`, { headers: headers(org) });
  const post = (path: string, body: unknown = {}, org = orgId) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(org),
      body: JSON.stringify(body),
    });

  const resetState = async () => {
    await raw!.db
      .update(tenants)
      .set({ settings: { onboarding: freshOnboardingState() } })
      .where(sql`${tenants.id} = ${tenantId}`);
  };

  beforeAll(async () => {
    if (!raw) return;
    await raw.db.insert(tenants).values([
      {
        id: tenantId,
        name: "Acme",
        workosOrganizationId: orgId,
        settings: { onboarding: freshOnboardingState() },
      },
      {
        id: legacyTenantId,
        name: "Legacy",
        workosOrganizationId: legacyOrgId,
        settings: { notificationEmail: "old@example.com" },
      },
      { id: otherTenantId, name: "Other", workosOrganizationId: otherOrgId },
    ]);
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    await raw.db
      .delete(tenants)
      .where(
        sql`${tenants.id} IN (${tenantId}, ${legacyTenantId}, ${otherTenantId})`,
      );
    await raw.close();
  });

  it("reports a freshly created workspace as pending, with nothing done", async () => {
    await resetState();
    const res = await get("/dashboard/onboarding/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pending: true,
      steps: {},
      currentStep: null,
      completedAt: null,
      dismissedAt: null,
    });
  });

  it("reports a pre-wizard workspace as not pending", async () => {
    // The whole backward-compatibility contract: no `onboarding` key means the
    // merchant is never dragged into a wizard for a workspace they already set
    // up by hand.
    const res = await get("/dashboard/onboarding/state", legacyOrgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: false, steps: {} });
  });

  it("records a completed step and the resume pointer", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/advance", {
      step: "store",
      status: "done",
      nextStep: "docs",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pending: true,
      steps: { store: "done" },
      currentStep: "docs",
    });

    // And it survives a re-read (it was persisted, not just echoed).
    const read = await get("/dashboard/onboarding/state");
    expect(await read.json()).toMatchObject({
      steps: { store: "done" },
      currentStep: "docs",
    });
  });

  it("records a skipped step", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/advance", {
      step: "telegram",
      status: "skipped",
    });
    expect(await res.json()).toMatchObject({ steps: { telegram: "skipped" } });
  });

  it("moves the resume pointer alone before an OAuth redirect", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/advance", {
      nextStep: "email",
    });
    expect(await res.json()).toMatchObject({ currentStep: "email", steps: {} });
  });

  it("rejects an unknown step key", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/advance", {
      step: "not_a_step",
      status: "done",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown status", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/advance", {
      step: "store",
      status: "in_progress",
    });
    expect(res.status).toBe(400);
  });

  it("dismiss ends the wizard ('Set up later')", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/dismiss");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: boolean;
      dismissedAt: string | null;
    };
    expect(body.pending).toBe(false);
    expect(body.dismissedAt).not.toBeNull();
  });

  it("complete ends the wizard", async () => {
    await resetState();
    const res = await post("/dashboard/onboarding/complete");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: boolean;
      completedAt: string | null;
    };
    expect(body.pending).toBe(false);
    expect(body.completedAt).not.toBeNull();
  });

  it("advancing a finished wizard does not reopen it", async () => {
    await resetState();
    await post("/dashboard/onboarding/dismiss");
    const res = await post("/dashboard/onboarding/advance", {
      step: "store",
      status: "done",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: false });
  });

  it("advance on a pre-wizard workspace does not start a wizard", async () => {
    // An unstamped workspace has no state to advance; a stray call must not
    // conjure one and gate a long-established merchant into the wizard.
    const res = await post(
      "/dashboard/onboarding/advance",
      { step: "store", status: "done" },
      legacyOrgId,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: false });

    const read = await get("/dashboard/onboarding/state", legacyOrgId);
    expect(await read.json()).toMatchObject({ pending: false });
  });

  it("exposes onboardingPending on the workspace list", async () => {
    await resetState();
    const res = await get("/dashboard/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: ReadonlyArray<{ id: string; onboardingPending: boolean }>;
    };
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      id: tenantId,
      onboardingPending: true,
    });

    const legacy = await get("/dashboard/workspaces", legacyOrgId);
    const legacyBody = (await legacy.json()) as {
      workspaces: ReadonlyArray<{ id: string; onboardingPending: boolean }>;
    };
    expect(legacyBody.workspaces[0]).toMatchObject({
      id: legacyTenantId,
      onboardingPending: false,
    });
  });

  it("is tenant-scoped: another org cannot advance this workspace", async () => {
    await resetState();
    await post(
      "/dashboard/onboarding/advance",
      { step: "store", status: "done" },
      otherOrgId,
    );
    // Our workspace is untouched — the other org wrote to its OWN tenant row.
    const read = await get("/dashboard/onboarding/state");
    expect(await read.json()).toMatchObject({ steps: {} });
  });
});
