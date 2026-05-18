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
  outlook:
    "Microsoft 365 mailbox connector (not yet implemented).",
};

const SUPPORTED_PROVIDERS = ["shopify", "gmail"] as const;

export default async function IntegrationsPage() {
  const tenantId = await getTenantId();
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

  return (
    <>
      <p className="muted">
        <Link href="/settings">← Settings</Link>
      </p>
      <h1>Integrations</h1>
      <p className="muted">
        Per-tenant credentials read by the worker. Installation is done out
        of the dashboard (the merchant installs the managed apps); this
        page is the source of truth for what the agent can talk to right now.
      </p>

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
                    {row.scopes.length} scope{row.scopes.length === 1 ? "" : "s"}{" "}
                    · installed {formatRelativeTime(row.installedAt)}
                    {row.revokedAt
                      ? ` · revoked ${formatRelativeTime(row.revokedAt)}`
                      : ""}
                  </div>
                </>
              ) : (
                <div className="muted">Not connected for this tenant.</div>
              )}
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
