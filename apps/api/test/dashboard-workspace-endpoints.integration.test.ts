import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  accountOpenrouterCredentials,
  makeDbClient,
  tenants,
} from "@support-agent/db";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  encrypt,
} from "@support-agent/services";
import { startServer, type ServerHandle } from "../src/server.js";
import type { ApiConfig } from "../src/bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Workspace management endpoints: list / create / rename / delete, plus the
// reworked deletion semantics — a workspace delete never touches the WorkOS
// org, the org is deleted only with its LAST workspace, and the account
// delete sweeps every workspace.
describeIfDb("apps/api — workspace endpoints (integration)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const dashToken = "ws-dash-token";
  const adminToken = "ws-admin-token";
  const managerId = randomUUID();

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
    dashboardApiToken: dashToken,
    adminApiToken: adminToken,
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let baseUrl = "";
  const orgsToClean: string[] = [];

  const currentAcceptance = (userId: string) => ({
    dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
    dpaVersion: DPA_VERSION,
    acceptedAt: "2026-06-01T00:00:00.000Z",
    acceptedByUserId: userId,
  });

  const seedWorkspace = async (
    org: string,
    name: string,
    createdAt: Date,
    opts: { legal?: "current" | "stale" | "none"; email?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const legal =
      (opts.legal ?? "current") === "current"
        ? currentAcceptance(managerId)
        : opts.legal === "stale"
          ? { ...currentAcceptance(managerId), dpaVersion: "1999-01-01" }
          : undefined;
    await raw!.db.insert(tenants).values({
      id,
      name,
      workosOrganizationId: org,
      createdAt,
      settings: {
        notificationEmail: opts.email ?? `owner-${org}@example.com`,
        ...(legal ? { legalAcceptance: legal } : {}),
      },
    });
    if (!orgsToClean.includes(org)) orgsToClean.push(org);
    return id;
  };

  const headers = (org: string) => ({
    authorization: `Bearer ${dashToken}`,
    "x-org-id": org,
    "x-user-id": managerId,
    "content-type": "application/json",
  });

  const get = (path: string, org: string) =>
    fetch(`${baseUrl}${path}`, { headers: headers(org) });
  const post = (path: string, org: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: headers(org),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  /** account.cleanup jobs enqueued for a tenant id (data payloads). */
  const cleanupJobs = async (
    tenantId: string,
  ): Promise<ReadonlyArray<{ data: Record<string, unknown> }>> => {
    const rows = await raw!.db.execute(
      sql`select data from pgboss.job
          where name = 'account.cleanup'
            and data->>'tenantId' = ${tenantId}`,
    );
    return rows as unknown as ReadonlyArray<{ data: Record<string, unknown> }>;
  };

  beforeAll(async () => {
    if (!raw) return;
    handle = await startServer(cfg);
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    for (const org of orgsToClean) {
      await raw.db
        .delete(accountOpenrouterCredentials)
        .where(sql`${accountOpenrouterCredentials.organizationId} = ${org}`);
      await raw.db
        .delete(tenants)
        .where(sql`${tenants.workosOrganizationId} = ${org}`);
    }
    await raw.close();
  });

  it("GET /dashboard/workspaces lists the org's workspaces default-first", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    const oldWs = await seedWorkspace(org, "Oldest", new Date("2026-01-01"));
    const newWs = await seedWorkspace(org, "Newest", new Date("2026-03-01"));
    const res = await get("/dashboard/workspaces", org);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: ReadonlyArray<{ id: string; name: string }>;
      defaultWorkspaceId: string | null;
    };
    expect(body.workspaces.map((w) => w.id)).toEqual([oldWs, newWs]);
    expect(body.defaultWorkspaceId).toBe(oldWs);
  });

  it("GET /dashboard/workspaces is empty (not 403) for an org with none — onboarding decides", async () => {
    if (!raw) return;
    const res = await get("/dashboard/workspaces", `org_${randomUUID().slice(0, 8)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: ReadonlyArray<unknown>;
      defaultWorkspaceId: string | null;
    };
    expect(body.workspaces).toEqual([]);
    expect(body.defaultWorkspaceId).toBeNull();
  });

  it("POST /dashboard/workspaces mints a workspace, copying the org's current legal acceptance", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    await seedWorkspace(org, "First", new Date("2026-01-01"));
    const res = await post("/dashboard/workspaces", org, {
      name: "Second store",
      notificationEmail: "second@example.com",
    });
    expect(res.status).toBe(200);
    const { workspaceId } = (await res.json()) as { workspaceId: string };
    const [row] = await raw.db
      .select()
      .from(tenants)
      .where(sql`${tenants.id} = ${workspaceId}`);
    expect(row?.name).toBe("Second store");
    expect(row?.workosOrganizationId).toBe(org);
    const settings = row?.settings as {
      notificationEmail?: string;
      legalAcceptance?: { dpaVersion?: string; acceptedByUserId?: string };
    };
    expect(settings.notificationEmail).toBe("second@example.com");
    // Copied verbatim from the default workspace (who/when preserved).
    expect(settings.legalAcceptance?.dpaVersion).toBe(DPA_VERSION);
    expect(settings.legalAcceptance?.acceptedByUserId).toBe(managerId);
  });

  it("POST /dashboard/workspaces → 403 legal_acceptance_required when the org's acceptance is stale", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    await seedWorkspace(org, "Stale", new Date("2026-01-01"), { legal: "stale" });
    const res = await post("/dashboard/workspaces", org, {
      name: "Should fail",
      notificationEmail: "x@example.com",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "legal_acceptance_required",
    );
  });

  it("POST /dashboard/workspaces → 409 use_onboarding for an org with zero workspaces", async () => {
    if (!raw) return;
    const res = await post(
      "/dashboard/workspaces",
      `org_${randomUUID().slice(0, 8)}`,
      { name: "Nope", notificationEmail: "x@example.com" },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "use_onboarding",
    );
  });

  it("POST /dashboard/workspaces/:id/rename renames an owned workspace, 404s a foreign one", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    const foreignOrg = `org_${randomUUID().slice(0, 8)}`;
    const ws = await seedWorkspace(org, "Old name", new Date("2026-01-01"));
    const foreign = await seedWorkspace(
      foreignOrg,
      "Not yours",
      new Date("2026-01-01"),
    );

    const ok = await post(`/dashboard/workspaces/${ws}/rename`, org, {
      name: "New name",
    });
    expect(ok.status).toBe(200);
    const [row] = await raw.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(sql`${tenants.id} = ${ws}`);
    expect(row?.name).toBe("New name");

    const stolen = await post(`/dashboard/workspaces/${foreign}/rename`, org, {
      name: "Hijack",
    });
    expect(stolen.status).toBe(404);
  });

  it("workspace delete wipes only that workspace; the org and siblings survive; cleanup job has NO org id and NO email", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    const keep = await seedWorkspace(org, "Keep", new Date("2026-01-01"));
    const drop = await seedWorkspace(org, "Drop", new Date("2026-02-01"));
    await raw.db.insert(accountOpenrouterCredentials).values({
      organizationId: org,
      apiKeyEncrypted: encrypt(cfg.encryptionKey, "sk-or-shared"),
    });

    const res = await post(`/dashboard/workspaces/${drop}/delete`, org);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("deleted");

    const rows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.workosOrganizationId} = ${org}`);
    expect(rows.map((r) => r.id)).toEqual([keep]);
    const accountRows = await raw.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(sql`${accountOpenrouterCredentials.organizationId} = ${org}`);
    expect(accountRows).toHaveLength(1);

    const jobs = await cleanupJobs(drop);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data["workosOrganizationId"]).toBeNull();
    expect(jobs[0]!.data["notificationEmail"]).toBeNull();
  });

  it("refuses to delete the LAST workspace (409 last_workspace) — account delete is the door", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    const only = await seedWorkspace(org, "Only", new Date("2026-01-01"));
    const res = await post(`/dashboard/workspaces/${only}/delete`, org);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "last_workspace",
    );
    const rows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.id} = ${only}`);
    expect(rows).toHaveLength(1);
  });

  it("account delete sweeps EVERY workspace; only the final (default) job carries the org id + email", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    const defaultWs = await seedWorkspace(org, "Default", new Date("2026-01-01"), {
      email: "default-owner@example.com",
    });
    const extraWs = await seedWorkspace(org, "Extra", new Date("2026-02-01"), {
      email: "extra-owner@example.com",
    });
    await raw.db.insert(accountOpenrouterCredentials).values({
      organizationId: org,
      apiKeyEncrypted: encrypt(cfg.encryptionKey, "sk-or-shared"),
    });

    const res = await post("/dashboard/account/delete", org);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      deletedWorkspaces: number;
    };
    expect(body.kind).toBe("deleted");
    expect(body.deletedWorkspaces).toBe(2);

    const rows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.workosOrganizationId} = ${org}`);
    expect(rows).toEqual([]);
    const accountRows = await raw.db
      .select()
      .from(accountOpenrouterCredentials)
      .where(sql`${accountOpenrouterCredentials.organizationId} = ${org}`);
    expect(accountRows).toEqual([]);

    // The non-default workspace's job must NOT delete the org or email.
    const extraJobs = await cleanupJobs(extraWs);
    expect(extraJobs).toHaveLength(1);
    expect(extraJobs[0]!.data["workosOrganizationId"]).toBeNull();
    expect(extraJobs[0]!.data["notificationEmail"]).toBeNull();
    // The default (last-deleted) workspace's job carries both.
    const defaultJobs = await cleanupJobs(defaultWs);
    expect(defaultJobs).toHaveLength(1);
    expect(defaultJobs[0]!.data["workosOrganizationId"]).toBe(org);
    expect(defaultJobs[0]!.data["notificationEmail"]).toBe(
      "default-owner@example.com",
    );
  });

  it("admin delete of ONE of two workspaces does not nuke the shared org (regression)", async () => {
    if (!raw) return;
    const org = `org_${randomUUID().slice(0, 8)}`;
    await seedWorkspace(org, "Survivor", new Date("2026-01-01"));
    const victim = await seedWorkspace(org, "Victim", new Date("2026-02-01"));

    const res = await fetch(`${baseUrl}/admin/tenants/${victim}/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const jobs = await cleanupJobs(victim);
    expect(jobs).toHaveLength(1);
    // Org delete suppressed — a sibling workspace still uses it. The email
    // still goes out (admin deletions notify the owner).
    expect(jobs[0]!.data["workosOrganizationId"]).toBeNull();
    expect(jobs[0]!.data["notificationEmail"]).toBe(
      `owner-${org}@example.com`,
    );
  });
});
