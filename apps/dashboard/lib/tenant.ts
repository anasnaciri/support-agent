import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { tenants } from "@support-agent/db";
import { db } from "./db";

// ============================================================
// Tenant resolution
// ============================================================
//
// Every Server Component that reads tenant-scoped data must call
// `getTenantId()` first. The lookup is:
//
//   WorkOS session
//     → user.organizationId  (set by AuthKit when the user signs in
//                              through an org-scoped flow)
//     → tenants WHERE workos_organization_id = ?
//     → tenants.id
//
// Unauthenticated requests: we call `withAuth()` (read-only — no
// cookie writes, which Server Components can't do) and on a null
// user, throw a Next.js `redirect("/sign-in")`. The /sign-in Route
// Handler is allowed to set cookies + redirect to WorkOS. We do NOT
// use `withAuth({ ensureSignedIn: true })` here: that helper triggers
// session-cookie refresh inside the call, which crashes with
// "Cookies can only be modified in a Server Action or Route Handler"
// when invoked from an RSC.
//
// Authenticated-but-not-onboarded paths throw `NoTenantAccess`:
//   - `no_organization`: signed in but no WorkOS org context.
//   - `no_tenant_mapping`: the org isn't linked to a tenants row yet.
// The route boundary (app/error.tsx) catches both and redirects to
// /no-access with the reason in the query string.

export class NoTenantAccess extends Error {
  constructor(
    public readonly reason: "no_organization" | "no_tenant_mapping",
    organizationId: string | null,
  ) {
    super(
      reason === "no_organization"
        ? "user has no WorkOS organization"
        : `no tenant linked to organization ${organizationId}`,
    );
    this.name = "NoTenantAccess";
  }
}

// Dev-only bypass. When `DASHBOARD_DEV_TENANT_ID` is set and we're not
// in production, skip WorkOS entirely and return the env-provided
// tenant id. Lets a local developer see the dashboard render without
// configuring WorkOS. NEVER honored in production — if both NODE_ENV
// and the var are set in prod, we explicitly ignore it so an
// accidental deploy with the var set doesn't open up access.
const devTenantBypass = (): string | null => {
  if (process.env["NODE_ENV"] === "production") return null;
  const dev = process.env["DASHBOARD_DEV_TENANT_ID"];
  return dev && dev.length > 0 ? dev : null;
};

export const getTenantId = async (): Promise<string> => {
  const dev = devTenantBypass();
  if (dev) return dev;

  // `withAuth()` (read-only) is safe in Server Components. A null
  // user means no session cookie — bounce to /sign-in via Next.js's
  // `redirect()`, which throws a redirect signal (NOT a regular error)
  // so anything below this line only executes when the user IS signed in.
  const { user, organizationId } = await withAuth();
  if (!user) {
    redirect("/sign-in");
  }
  if (!organizationId) {
    throw new NoTenantAccess("no_organization", null);
  }
  const rows = await db()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.workosOrganizationId, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new NoTenantAccess("no_tenant_mapping", organizationId);
  }
  return row.id;
};
