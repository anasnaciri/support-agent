import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeDbClient, rolePermissions, roles, tenants } from "@support-agent/db";

import { startServer, type ServerHandle } from "../../server.js";
import { TEST_DASHBOARD_VERIFIER } from "../../tests/support/dashboard-auth.js";
import { makeSessionCodec } from "../dashboard-session.js";
import type { WorkosOrgAdminDirectory } from "../workos-directory.js";
import type { ApiConfig } from "../../bootstrap.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

const SPA_ORIGIN = "http://localhost:3198";
const SESSION_PASSWORD = "integration-onboard-session-password-32-plus";
// Unique per run so a crashed prior run can't leave an org id that makes the
// "creates a fresh org" case see alreadyExisted:true.
const RUN = randomBytes(4).toString("hex");
const ORG_PREFIX = `org_onbtest_${RUN}`;

// Fake WorkOS token endpoint: ECHO the requested organization_id into the minted
// token so the re-minted cookie carries exactly the org the onboard endpoint
// just resolved (the whole point of the re-mint).
const workosFetch = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).includes("/user_management/authenticate")) {
    const grant = JSON.parse(String(init?.body)) as {
      organization_id?: string;
    };
    const org = grant.organization_id ?? "";
    return new Response(
      JSON.stringify({
        access_token: `dash|${org}|user_new`,
        refresh_token: "rt_2",
        organization_id: org || null,
        user: {
          id: "user_new",
          email: "new@ex.com",
          first_name: "Nova",
          last_name: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

// Stateful recording admin directory: models WorkOS memberships so onboarding is
// genuinely idempotent (a retry re-resolves the org it just created).
const makeRecordingAdmin = () => {
  const memberships = new Map<string, string[]>();
  const created: string[] = [];
  let counter = 0;
  const dir: WorkosOrgAdminDirectory = {
    createOrganization: async () => {
      counter += 1;
      const id = `${ORG_PREFIX}_${counter}`;
      created.push(id);
      return { id };
    },
    addOrganizationMembership: async (orgId, userId) => {
      const list = memberships.get(userId) ?? [];
      list.push(orgId);
      memberships.set(userId, list);
      return true;
    },
    listOrganizationMemberships: async (userId) =>
      memberships.get(userId) ?? [],
    sendInvitation: async () => ({ id: "inv_x" }),
  };
  const reset = () => {
    memberships.clear();
    created.length = 0;
  };
  const seed = (userId: string, orgId: string) =>
    memberships.set(userId, [orgId]);
  return { dir, created, reset, seed };
};

const setCookieValue = (headers: Headers, name: string): string | undefined => {
  for (const c of headers.getSetCookie()) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return undefined;
};

describeIfDb("apps/api — dashboard onboarding (org provision + re-mint)", () => {
  const raw = databaseUrl ? makeDbClient({ databaseUrl }) : null;
  const codec = makeSessionCodec(SESSION_PASSWORD);
  const admin = makeRecordingAdmin();

  const cfg = {
    port: 0,
    databaseUrl: databaseUrl!,
    encryptionKey: randomBytes(32),
    stateSigningKey: "state-key",
    shopify: {
      clientId: "c",
      clientSecret: "s",
      callbackUrl: "http://localhost/shopify/auth/callback",
      apiVersion: "2025-01",
    },
    google: null,
    approvalSigningKey: "a",
    dashboardBaseUrl: null,
    workos: {
      clientId: "client_test",
      jwksUrl: "https://example/jwks",
      issuer: null,
      apiKey: "sk_test",
    },
    dashboardBff: {
      sessionPassword: SESSION_PASSWORD,
      redirectUri: "http://localhost/dashboard/auth/callback",
      spaOrigins: [SPA_ORIGIN],
    },
  } as ApiConfig;

  let handle: ServerHandle | null = null;
  let base = "";

  // A NO-ORG cookie: the token's org slot is empty, so the verifier rejects it
  // (needsOnboarding), forcing the provision path.
  const noOrgCookie = async (): Promise<string> =>
    `sa-dash-session=${await codec.seal({
      accessToken: "dash||user_new",
      refreshToken: "rt_1",
      user: {
        id: "user_new",
        email: "new@ex.com",
        firstName: "Nova",
        lastName: null,
      },
    })}`;

  const onboard = (cookie: string, body: unknown): Promise<Response> =>
    fetch(`${base}/dashboard/auth/onboard`, {
      method: "POST",
      headers: {
        cookie,
        origin: SPA_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const goodBody = {
    name: "Nova Supplies",
    notificationEmail: "ops@nova.co",
    legalAccepted: true,
  };

  beforeAll(async () => {
    if (!raw) return;
    handle = await startServer(cfg, {
      dashboardTokenVerifier: TEST_DASHBOARD_VERIFIER,
      dashboardSessionCodec: codec,
      workosOAuthFetch: workosFetch,
      workosOrgAdminDirectory: admin.dir,
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (!raw) return;
    if (handle) await handle.close();
    const rows = await raw.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.workosOrganizationId} LIKE ${`${ORG_PREFIX}%`}`);
    for (const r of rows) {
      await raw.db.delete(rolePermissions).where(
        sql`${rolePermissions.roleId} IN (SELECT id FROM roles WHERE tenant_id = ${r.id})`,
      );
      await raw.db.delete(roles).where(sql`${roles.tenantId} = ${r.id}`);
      await raw.db.delete(tenants).where(sql`${tenants.id} = ${r.id}`);
    }
    await raw.close();
  });

  it("session reports needsOnboarding for an authenticated user with no org", async () => {
    const res = await fetch(`${base}/dashboard/auth/session`, {
      headers: { cookie: await noOrgCookie() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      needsOnboarding?: boolean;
      organizationId?: string;
      user?: { id: string };
    };
    expect(body.needsOnboarding).toBe(true);
    expect(body.organizationId).toBeUndefined();
    expect(body.user?.id).toBe("user_new");
  });

  it("onboard provisions an org, re-mints the cookie, and creates the tenant", async () => {
    admin.reset();
    const res = await onboard(await noOrgCookie(), goodBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      alreadyExisted: boolean;
      organizationId: string;
    };
    expect(body.alreadyExisted).toBe(false);
    expect(body.organizationId).toBe(`${ORG_PREFIX}_1`);
    expect(admin.created).toEqual([`${ORG_PREFIX}_1`]);

    // The response re-minted the session cookie so it now carries the new org —
    // a follow-up read authenticates and resolves the freshly-created tenant.
    const remint = setCookieValue(res.headers, "sa-dash-session");
    expect(remint).toBeTruthy();
    const tenantRes = await fetch(`${base}/dashboard/tenant`, {
      headers: { cookie: `sa-dash-session=${remint}` },
    });
    expect(tenantRes.status).toBe(200);
    const tenant = (await tenantRes.json()) as {
      tenant: { tenantId: string; name: string } | null;
    };
    expect(tenant.tenant?.tenantId).toBe(body.tenantId);
    expect(tenant.tenant?.name).toBe("Nova Supplies");
  });

  it("is idempotent: a retry reuses the just-created org (no second org)", async () => {
    // Continues the prior test's membership state (user_new now belongs to
    // ORG_PREFIX_1), so the retry resolves that org instead of creating another.
    const res = await onboard(await noOrgCookie(), goodBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alreadyExisted: boolean;
      organizationId: string;
    };
    expect(body.alreadyExisted).toBe(true);
    expect(body.organizationId).toBe(`${ORG_PREFIX}_1`);
    expect(admin.created).toEqual([`${ORG_PREFIX}_1`]); // no new org created
  });

  it("reuses an existing membership without creating a new org", async () => {
    admin.reset();
    admin.seed("user_new", `${ORG_PREFIX}_seed`);
    const res = await onboard(await noOrgCookie(), goodBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizationId: string };
    expect(body.organizationId).toBe(`${ORG_PREFIX}_seed`);
    expect(admin.created).toEqual([]); // reused the existing org
  });

  it("validates the form (bad name / email / missing legal)", async () => {
    const cookie = await noOrgCookie();
    expect((await onboard(cookie, { ...goodBody, name: "x" })).status).toBe(400);
    expect(
      (await onboard(cookie, { ...goodBody, notificationEmail: "nope" })).status,
    ).toBe(400);
    expect(
      (await onboard(cookie, { ...goodBody, legalAccepted: false })).status,
    ).toBe(400);
  });

  it("401s onboard with no session cookie", async () => {
    const res = await fetch(`${base}/dashboard/auth/onboard`, {
      method: "POST",
      headers: { origin: SPA_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(goodBody),
    });
    expect(res.status).toBe(401);
  });
});
