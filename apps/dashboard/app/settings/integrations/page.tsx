import { withAuth } from "@workos-inc/authkit-nextjs";
import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";

import { connectorConnections } from "@support-agent/db";
import { isConnectorScopeGranted } from "@support-agent/services";
import { db } from "@/lib/db";
import { capabilitiesForProvider } from "@/lib/catalog";
import { getTenantId } from "@/lib/tenant";
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
  disconnectGmailAction,
  disconnectGoogleSheetsAction,
} from "./actions";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  gmail: "Gmail",
  google_sheets: "Google Sheets",
  outlook: "Outlook",
};

const PROVIDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  shopify:
    "Powers order, customer, and fulfillment lookups for the agent. Installed via the managed Shopify app.",
  gmail:
    "Inbound customer threads + outbound replies on this connection. Installed via Google OAuth.",
  google_sheets:
    "Spreadsheet read/write access for Sheets-backed workflows. Installed via Google OAuth.",
  outlook: "Microsoft 365 mailbox connector (not yet implemented).",
};

const SUPPORTED_PROVIDERS = ["shopify", "gmail", "google_sheets"] as const;

/**
 * Capabilities surfaced on a connector card are derived from each tool's
 * `requiredConnectorScopes` declaration via `capabilitiesForProvider`.
 * No hardcoded list — adding a new tool that declares a new scope
 * automatically surfaces it as a new capability row here.
 */

const ShopifyIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="-18 0 292 292"
    className="size-5 shrink-0"
    preserveAspectRatio="xMidYMid"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-1.703-1.703-5.029-1.185-6.32-.805-.19.056-3.388 1.043-8.678 2.68-5.18-14.906-14.322-28.604-30.405-28.604-.444 0-.901.018-1.358.044C129.31 3.407 123.644.779 118.75.779c-37.465 0-55.364 46.835-60.976 70.635-14.558 4.511-24.9 7.718-26.221 8.133-8.126 2.549-8.383 2.805-9.45 10.462C21.3 95.806.038 260.235.038 260.235l165.678 31.042 89.77-19.42S223.973 58.8 223.775 57.34zM156.49 40.848l-14.019 4.339c.005-.988.01-1.96.01-3.023 0-9.264-1.286-16.723-3.349-22.636 8.287 1.04 13.806 10.469 17.358 21.32zm-27.638-19.483c2.304 5.773 3.802 14.058 3.802 25.238 0 .572-.005 1.095-.01 1.624-9.117 2.824-19.024 5.89-28.953 8.966 5.575-21.516 16.025-31.908 25.161-35.828zm-11.131-10.537c1.617 0 3.246.549 4.805 1.622-12.007 5.65-24.877 19.88-30.312 48.297l-22.886 7.088C75.694 46.16 90.81 10.828 117.72 10.828z"
      fill="#95BF46"
    />
    <path
      d="M221.237 54.983c-1.055-.088-23.383-1.743-23.383-1.743s-15.507-15.395-17.209-17.099c-.637-.634-1.496-.959-2.394-1.099l-12.527 256.233 89.762-19.418S223.972 58.8 223.774 57.34c-.201-1.46-1.48-2.268-2.537-2.357"
      fill="#5E8E3E"
    />
    <path
      d="M135.242 104.585l-11.069 32.926s-9.698-5.176-21.586-5.176c-17.428 0-18.305 10.937-18.305 13.693 0 15.038 39.2 20.8 39.2 56.024 0 27.713-17.577 45.558-41.277 45.558-28.44 0-42.984-17.7-42.984-17.7l7.615-25.16s14.95 12.835 27.565 12.835c8.243 0 11.596-6.49 11.596-11.232 0-19.616-32.16-20.491-32.16-52.724 0-27.129 19.472-53.382 58.778-53.382 15.145 0 22.627 4.338 22.627 4.338"
      fill="#FFF"
    />
  </svg>
);

const GmailIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    className="size-5 shrink-0"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M2 11.9556C2 8.47078 2 6.7284 2.67818 5.39739C3.27473 4.22661 4.22661 3.27473 5.39739 2.67818C6.7284 2 8.47078 2 11.9556 2H20.0444C23.5292 2 25.2716 2 26.6026 2.67818C27.7734 3.27473 28.7253 4.22661 29.3218 5.39739C30 6.7284 30 8.47078 30 11.9556V20.0444C30 23.5292 30 25.2716 29.3218 26.6026C28.7253 27.7734 27.7734 28.7253 26.6026 29.3218C25.2716 30 23.5292 30 20.0444 30H11.9556C8.47078 30 6.7284 30 5.39739 29.3218C4.22661 28.7253 3.27473 27.7734 2.67818 26.6026C2 25.2716 2 23.5292 2 20.0444V11.9556Z"
      fill="white"
    />
    <path
      d="M22.0515 8.52295L16.0644 13.1954L9.94043 8.52295V8.52421L9.94783 8.53053V15.0732L15.9954 19.8466L22.0515 15.2575V8.52295Z"
      fill="#EA4335"
    />
    <path
      d="M23.6231 7.38639L22.0508 8.52292V15.2575L26.9983 11.459V9.17074C26.9983 9.17074 26.3978 5.90258 23.6231 7.38639Z"
      fill="#FBBC05"
    />
    <path
      d="M22.0508 15.2575V23.9924H25.8428C25.8428 23.9924 26.9219 23.8813 26.9995 22.6513V11.459L22.0508 15.2575Z"
      fill="#34A853"
    />
    <path
      d="M9.94811 24.0001V15.0732L9.94043 15.0669L9.94811 24.0001Z"
      fill="#C5221F"
    />
    <path
      d="M9.94014 8.52404L8.37646 7.39382C5.60179 5.91001 5 9.17692 5 9.17692V11.4651L9.94014 15.0667V8.52404Z"
      fill="#C5221F"
    />
    <path
      d="M9.94043 8.52441V15.0671L9.94811 15.0734V8.53073L9.94043 8.52441Z"
      fill="#C5221F"
    />
    <path
      d="M5 11.4668V22.6591C5.07646 23.8904 6.15673 24.0003 6.15673 24.0003H9.94877L9.94014 15.0671L5 11.4668Z"
      fill="#4285F4"
    />
  </svg>
);

const GoogleSheetsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    className="size-5 shrink-0"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M19 2H8.5A2.5 2.5 0 0 0 6 4.5v23A2.5 2.5 0 0 0 8.5 30h15a2.5 2.5 0 0 0 2.5-2.5V9l-7-7Z"
      fill="#0F9D58"
    />
    <path d="M19 2v5.5A1.5 1.5 0 0 0 20.5 9H26l-7-7Z" fill="#87CEAC" />
    <path
      d="M10 13.5A1.5 1.5 0 0 1 11.5 12h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-9Zm2 1.5v2h3v-2h-3Zm5 0v2h3v-2h-3Zm-5 4v3h3v-3h-3Zm5 0v3h3v-3h-3Z"
      fill="white"
    />
  </svg>
);

const PROVIDER_ICONS = {
  shopify: ShopifyIcon,
  gmail: GmailIcon,
  google_sheets: GoogleSheetsIcon,
} satisfies Readonly<
  Record<(typeof SUPPORTED_PROVIDERS)[number], typeof ShopifyIcon>
>;

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
    (Array.isArray(gmailParam) ? gmailParam[0] : gmailParam) === "disconnected";
  const sheetsParam = params["sheets"];
  const sheetsBanner =
    (Array.isArray(sheetsParam) ? sheetsParam[0] : sheetsParam) ===
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
      <SettingsBreadcrumb current="Integrations" />

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
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">active</code>
          .
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
          const ProviderIcon = PROVIDER_ICONS[p];
          const tone = !row
            ? "missing"
            : row.status === "active"
              ? "active"
              : "revoked";
          const showConnect = !!apiBaseUrl && tone !== "active";
          const disconnectAction =
            p === "gmail"
              ? disconnectGmailAction
              : p === "google_sheets"
                ? disconnectGoogleSheetsAction
                : null;
          const showDisconnect = !!disconnectAction && tone === "active";
          const capabilities = capabilitiesForProvider(p);

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

                {/* Per-capability scope grid, derived from each tool's
                    `requiredConnectorScopes` declaration. Surfaces the
                    "this scope unlocks this tool" mapping inline so the
                    operator sees if the merchant needs to re-OAuth to
                    pick up a newly-added capability. Only renders when
                    there's an active connection AND at least one tool
                    declares scopes for this provider — no sense showing
                    an empty grid. */}
                {row && tone === "active" && capabilities.length > 0 ? (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-foreground">
                      Granted capabilities
                    </p>
                    <ul className="space-y-1 text-xs">
                      {capabilities.map((cap) => {
                        const granted = isConnectorScopeGranted(
                          p,
                          cap.scope,
                          row.scopes,
                        );
                        return (
                          <li
                            key={cap.scope}
                            className="flex items-center justify-between gap-2"
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                aria-hidden
                                className={
                                  granted
                                    ? "inline-block size-1.5 rounded-full bg-primary"
                                    : "inline-block size-1.5 rounded-full bg-destructive"
                                }
                              />
                              <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                                {cap.scope}
                              </code>
                            </span>
                            <span className="text-muted-foreground">
                              {cap.tools}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    {capabilities.some(
                      (c) => !isConnectorScopeGranted(p, c.scope, row.scopes),
                    ) ? (
                      <p className="pt-1 text-[11px] leading-snug text-muted-foreground">
                        Missing a capability? Click <strong>Reinstall</strong>{" "}
                        {p === "shopify"
                          ? "below — Shopify shows the merchant an “update permissions” prompt without losing the existing connection."
                          : "below to re-run the OAuth grant with the latest scope set."}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {/* Reinstall path: active Shopify row but scope set
                      is missing something. We don't gate this on the
                      capability flag — operators can always reinstall
                      to refresh scopes. Renders ONLY when the install
                      is active (the existing showConnect path handles
                      missing / revoked). */}
                  {p === "shopify" &&
                  row &&
                  tone === "active" &&
                  apiBaseUrl &&
                  capabilities.some(
                    (c) => !isConnectorScopeGranted(p, c.scope, row.scopes),
                  ) ? (
                    <Button variant="outline" asChild>
                      <a
                        href={`${apiBaseUrl}/shopify/install?tenant=${encodeURIComponent(
                          tenantId,
                        )}`}
                      >
                        Reinstall to update scopes
                      </a>
                    </Button>
                  ) : null}

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
                      {p === "google_sheets" ? (
                        <Button asChild>
                          <a
                            href={
                              `${apiBaseUrl}/google/install?tenant=${encodeURIComponent(
                                tenantId,
                              )}&provider=google_sheets` +
                              (loginHint
                                ? `&login_hint=${encodeURIComponent(loginHint)}`
                                : "")
                            }
                          >
                            {tone === "missing"
                              ? "Connect Sheets"
                              : "Reconnect Sheets"}
                          </a>
                        </Button>
                      ) : null}
                    </>
                  ) : null}

                  {showDisconnect && disconnectAction ? (
                    <form action={disconnectAction}>
                      <Button type="submit" variant="outline">
                        Disconnect {label}
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
