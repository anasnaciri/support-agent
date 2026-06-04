import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import { AlertTriangle, Settings2 } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_ICONS,
  getApiBaseUrl,
  connectHref,
} from "./_shared";
import {
  disconnectShopifyAction,
  disconnectGmailAction,
  disconnectGoogleSheetsAction,
} from "./actions";

const DISCONNECT_ACTIONS: Readonly<
  Partial<Record<string, () => Promise<void>>>
> = {
  shopify: disconnectShopifyAction,
  gmail: disconnectGmailAction,
  google_sheets: disconnectGoogleSheetsAction,
};

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const tenantId = ctx.tenantId;
  const params = (await searchParams) ?? {};
  const shopifyParam = params["shopify"];
  const shopifyBanner =
    (Array.isArray(shopifyParam) ? shopifyParam[0] : shopifyParam) ===
    "disconnected";
  const gmailParam = params["gmail"];
  const gmailBanner =
    (Array.isArray(gmailParam) ? gmailParam[0] : gmailParam) === "disconnected";
  const sheetsParam = params["sheets"];
  const sheetsBanner =
    (Array.isArray(sheetsParam) ? sheetsParam[0] : sheetsParam) ===
    "disconnected";
  // Set by the apps/api OAuth callback when it redirects the merchant back
  // here after a successful connect (`?connected=shopify`, `=gmail`, …).
  const connectedParam = params["connected"];
  const connectedValue = Array.isArray(connectedParam)
    ? connectedParam[0]
    : connectedParam;
  const connectedLabel = connectedValue
    ? (PROVIDER_LABELS[connectedValue] ?? null)
    : null;
  const apiBaseUrl = getApiBaseUrl();
  const { user } = await withAuth();
  const loginHint = user?.email ?? null;

  const [rows, settings] = await Promise.all([
    api.connections(ctx),
    api.settings(ctx),
  ]);
  const legalAccepted = settings.legalAcceptance !== null;

  const byProvider = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, r);
  }

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Integrations" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-tenant credentials read by the worker. Click Connect and the
          provider (Shopify or Google) takes over; on completion the connection
          flips to{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">active</code>
          . Open <strong>Manage</strong> on a connector to see its account,
          scopes, and granted capabilities.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Looking for your LLM provider key? It lives on its own page —{" "}
          <Link
            href="/settings/llm"
            className="font-medium text-primary hover:underline"
          >
            Settings → LLM provider
          </Link>
          .
        </p>
      </div>

      {shopifyBanner ? (
        <Alert variant="success">
          <AlertDescription>Shopify disconnected.</AlertDescription>
        </Alert>
      ) : null}

      {gmailBanner ? (
        <Alert variant="success">
          <AlertDescription>Gmail disconnected.</AlertDescription>
        </Alert>
      ) : null}

      {sheetsBanner ? (
        <Alert variant="success">
          <AlertDescription>Google Sheets disconnected.</AlertDescription>
        </Alert>
      ) : null}

      {connectedLabel ? (
        <Alert variant="success">
          <AlertDescription>{connectedLabel} connected.</AlertDescription>
        </Alert>
      ) : null}

      {!legalAccepted ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Legal acceptance required</AlertTitle>
          <AlertDescription>
            Accept the current data processing notice and DPA in{" "}
            <Link
              href="/settings/legal"
              className="font-medium text-primary hover:underline"
            >
              Settings → Legal
            </Link>{" "}
            before connecting production providers.
          </AlertDescription>
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
          const ProviderIcon = PROVIDER_ICONS[p];
          const tone = !row
            ? "missing"
            : row.status === "active"
              ? "active"
              : "revoked";
          const isActive = tone === "active";
          const disconnectAction = DISCONNECT_ACTIONS[p];

          return (
            <Card key={p}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ProviderIcon />
                    {label}
                  </CardTitle>
                  <Badge variant={integrationStatusVariant(tone)}>{tone}</Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  {isActive ? (
                    <>
                      <Button variant="outline" asChild>
                        <Link href={`/settings/integrations/${p}`}>
                          <Settings2 className="size-3.5" aria-hidden />
                          Manage
                        </Link>
                      </Button>
                      {disconnectAction ? (
                        <form action={disconnectAction}>
                          <Button type="submit" variant="destructive">
                            Disconnect
                          </Button>
                        </form>
                      ) : null}
                    </>
                  ) : !legalAccepted ? (
                    <Button asChild>
                      <Link href="/settings/legal">Review legal terms</Link>
                    </Button>
                  ) : apiBaseUrl ? (
                    <Button asChild>
                      <a
                        href={connectHref(p, apiBaseUrl, tenantId, loginHint)}
                      >
                        {tone === "revoked"
                          ? `Reconnect ${label}`
                          : `Connect ${label}`}
                      </a>
                    </Button>
                  ) : null}
                </div>
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
                  <TableHead>Account / shop</TableHead>
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
                      {r.installedAt ? formatRelativeTime(r.installedAt) : "—"}
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
