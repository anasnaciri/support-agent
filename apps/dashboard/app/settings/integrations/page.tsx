import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { connectorConnections } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { formatRelativeTime } from "@/lib/format";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  gmail: "Gmail",
  outlook: "Outlook",
};

const PROVIDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  shopify:
    "Powers order, customer, and fulfillment lookups for the agent. Installed via the managed Shopify app.",
  gmail:
    "Inbound customer threads + outbound replies on this connection. Installed via Google OAuth.",
  outlook: "Microsoft 365 mailbox connector (not yet implemented).",
};

const SUPPORTED_PROVIDERS = ["shopify", "gmail"] as const;

export default async function IntegrationsPage() {
  const tenantId = await getTenantId();
  const apiBaseUrl = process.env["DASHBOARD_API_BASE_URL"];
  const { user } = await withAuth();
  const loginHint = user?.email ?? null;

  const rows = await db()
    .select({
      id: connectorConnections.id,
      provider: connectorConnections.provider,
      shopDomain: connectorConnections.shopDomain,
      status: connectorConnections.status,
      scopes: connectorConnections.scopes,
      installedAt: connectorConnections.installedAt,
      revokedAt: connectorConnections.revokedAt,
      updatedAt: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.tenantId, tenantId))
    .orderBy(desc(connectorConnections.installedAt));

  const byProvider = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, r);
  }

  // Connect buttons hit apps/api install endpoints, which 302 to the
  // provider's OAuth flow. We pre-fill `tenant=<id>` server-side from
  // the signed-in session; the user only needs to provide the Shopify
  // shop domain on the Shopify form. Gmail just needs a click.

  return (
    <>
      <p className="muted">
        <Link href="/settings">← Settings</Link>
      </p>
      <h1>Integrations</h1>
      <p className="muted">
        Per-tenant credentials read by the worker. After clicking Connect,
        the provider (Shopify or Google) takes over; on completion the
        token lands in <code>connector_connections</code> and this page
        flips to <code>active</code>.
      </p>

      {!apiBaseUrl ? (
        <div className="banner warn">
          Connect buttons disabled —{" "}
          <code>DASHBOARD_API_BASE_URL</code> is not set on the dashboard
          server. Point it at the public origin of <code>apps/api</code>{" "}
          (e.g. <code>https://api.example.com</code>) and restart.
        </div>
      ) : null}

      <div className="stat-grid">
        {SUPPORTED_PROVIDERS.map((p) => {
          const row = byProvider.get(p);
          const label = PROVIDER_LABELS[p] ?? p;
          const description = PROVIDER_DESCRIPTIONS[p] ?? "";
          const tone = !row
            ? "missing"
            : row.status === "active"
              ? "active"
              : "revoked";
          const showConnect = !!apiBaseUrl && tone !== "active";

          return (
            <div key={p} className="stat">
              <div className="label">{label}</div>
              <div className="value">
                <span className={`badge integration-${tone}`}>{tone}</span>
              </div>
              {row ? (
                <>
                  {row.shopDomain ? (
                    <div className="muted">
                      <code>{row.shopDomain}</code>
                    </div>
                  ) : null}
                  <div className="muted">
                    {row.scopes.length} scope
                    {row.scopes.length === 1 ? "" : "s"} · installed{" "}
                    {formatRelativeTime(row.installedAt)}
                    {row.revokedAt
                      ? ` · revoked ${formatRelativeTime(row.revokedAt)}`
                      : ""}
                  </div>
                </>
              ) : (
                <div className="muted">Not connected for this tenant.</div>
              )}

              {showConnect ? (
                <div style={{ marginTop: 12 }}>
                  {p === "shopify" ? (
                    <form
                      method="get"
                      action={`${apiBaseUrl}/shopify/install`}
                      className="integration-connect"
                    >
                      <input type="hidden" name="tenant" value={tenantId} />
                      <input
                        type="text"
                        name="shop"
                        required
                        pattern="[a-z0-9][a-z0-9-]*\.myshopify\.com"
                        placeholder="yourshop.myshopify.com"
                        aria-label="Shopify shop domain"
                      />
                      <button type="submit" className="btn btn-primary">
                        {tone === "revoked" ? "Reconnect" : "Connect"}
                      </button>
                    </form>
                  ) : null}
                  {p === "gmail" ? (
                    <a
                      className="btn btn-primary"
                      href={
                        `${apiBaseUrl}/google/install?tenant=${encodeURIComponent(
                          tenantId,
                        )}` +
                        (loginHint
                          ? `&login_hint=${encodeURIComponent(loginHint)}`
                          : "")
                      }
                    >
                      {tone === "revoked" ? "Reconnect" : "Connect Gmail"}
                    </a>
                  ) : null}
                </div>
              ) : null}

              <div className="muted" style={{ marginTop: 8 }}>
                {description}
              </div>
            </div>
          );
        })}
      </div>

      {rows.length > 0 ? (
        <>
          <h2>All connections</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Shop</th>
                <th>Status</th>
                <th>Scopes</th>
                <th>Installed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{PROVIDER_LABELS[r.provider] ?? r.provider}</td>
                  <td>
                    {r.shopDomain ? (
                      <code>{r.shopDomain}</code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge integration-${r.status}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>
                    {r.scopes.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <code style={{ fontSize: 12 }}>
                        {r.scopes.join(", ")}
                      </code>
                    )}
                  </td>
                  <td>{formatRelativeTime(r.installedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  );
}
