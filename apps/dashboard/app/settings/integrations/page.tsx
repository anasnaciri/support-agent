import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { ArrowLeft, AlertTriangle } from "lucide-react";

import { connectorConnections } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { disconnectGmailAction } from "./actions";

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

const originFromEnvUrl = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const getApiBaseUrl = (): string | null =>
  originFromEnvUrl(process.env["DASHBOARD_API_BASE_URL"]) ??
  originFromEnvUrl(process.env["SHOPIFY_APP_CALLBACK_URL"]) ??
  originFromEnvUrl(process.env["GOOGLE_OAUTH_CALLBACK_URL"]) ??
  originFromEnvUrl(process.env["APPROVAL_BASE_URL"]);

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const tenantId = await getTenantId();
  const params = (await searchParams) ?? {};
  const gmailParam = params["gmail"];
  const gmailBanner =
    (Array.isArray(gmailParam) ? gmailParam[0] : gmailParam) ===
    "disconnected";
  const apiBaseUrl = getApiBaseUrl();
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

  return (
    <div className="space-y-6">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Settings
      </Link>

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-tenant credentials read by the worker. After clicking Connect, the
          provider (Shopify or Google) takes over; on completion the token lands
          in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            connector_connections
          </code>{" "}
          and this page flips to{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">active</code>.
        </p>
      </div>

      {gmailBanner ? (
        <Alert variant="success">
          <AlertDescription>Gmail disconnected.</AlertDescription>
        </Alert>
      ) : null}

      {!apiBaseUrl ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Connect buttons disabled</AlertTitle>
          <AlertDescription>
            No API origin is configured for the dashboard. Set{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              DASHBOARD_API_BASE_URL
            </code>{" "}
            or one of the API callback URL env vars to the public origin of{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              apps/api
            </code>{" "}
            and restart.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
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
          const showDisconnect = p === "gmail" && tone === "active";

          return (
            <Card key={p}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{label}</CardTitle>
                  <Badge variant={integrationStatusVariant(tone)}>{tone}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {row ? (
                  <div className="space-y-1 text-sm">
                    {row.shopDomain ? (
                      <div>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {row.shopDomain}
                        </code>
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      {row.scopes.length} scope
                      {row.scopes.length === 1 ? "" : "s"} · installed{" "}
                      {formatRelativeTime(row.installedAt)}
                      {row.revokedAt
                        ? ` · revoked ${formatRelativeTime(row.revokedAt)}`
                        : ""}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    Not connected for this tenant.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  {showConnect ? (
                    <>
                      {p === "shopify" ? (
                        <Button asChild>
                          <a
                            href={`${apiBaseUrl}/shopify/install?tenant=${encodeURIComponent(
                              tenantId,
                            )}`}
                          >
                            {tone === "revoked"
                              ? "Reconnect"
                              : "Connect Shopify"}
                          </a>
                        </Button>
                      ) : null}
                      {p === "gmail" ? (
                        <Button asChild>
                          <a
                            href={
                              `${apiBaseUrl}/google/install?tenant=${encodeURIComponent(
                                tenantId,
                              )}` +
                              (loginHint
                                ? `&login_hint=${encodeURIComponent(loginHint)}`
                                : "")
                            }
                          >
                            {tone === "missing"
                              ? "Connect Gmail"
                              : "Reconnect Gmail"}
                          </a>
                        </Button>
                      ) : null}
                    </>
                  ) : null}

                  {showDisconnect ? (
                    <form action={disconnectGmailAction}>
                      <Button type="submit" variant="outline">
                        Disconnect Gmail
                      </Button>
                    </form>
                  ) : null}
                </div>

                <p className="text-xs text-muted-foreground">{description}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {rows.length > 0 ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">All connections</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Installed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {PROVIDER_LABELS[r.provider] ?? r.provider}
                    </TableCell>
                    <TableCell>
                      {r.shopDomain ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {r.shopDomain}
                        </code>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={integrationStatusVariant(r.status)}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.scopes.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <code className="text-xs">{r.scopes.join(", ")}</code>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(r.installedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
