import { notFound } from "next/navigation";
import { AlertTriangle, ClipboardList } from "lucide-react";

import { isConnectorScopeGranted } from "@support-agent/dashboard-contracts";
import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import { capabilitiesForProvider } from "@/lib/catalog";
import {
  connectorHealth,
  connectorHealthReasonLabel,
} from "@/lib/connector-health";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import {
  PROVIDER_LABELS,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_ICONS,
  getApiBaseUrl,
  connectHref,
  isSupportedProvider,
} from "../_shared";
import { shopifyConnectState } from "../connect-error";
import {
  disconnectShopifyAction,
  disconnectGmailAction,
  disconnectGoogleSheetsAction,
} from "../actions";
import {
  saveSupplierEscalationAction,
  clearSupplierEscalationAction,
} from "@/app/settings/supplier-escalation/actions";
import { googleSheetsUrlForSpreadsheetId } from "@/app/settings/supplier-escalation/sheet-url";

interface Props {
  readonly params: Promise<{ readonly provider: string }>;
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const firstParam = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function ConnectorManagePage({
  params,
  searchParams,
}: Props) {
  const { provider } = await params;
  if (!isSupportedProvider(provider)) notFound();

  const ctx = await requirePermission("settings.integrations");
  const apiBaseUrl = getApiBaseUrl();

  const label = PROVIDER_LABELS[provider] ?? provider;
  const description = PROVIDER_DESCRIPTIONS[provider] ?? "";
  const ProviderIcon = PROVIDER_ICONS[provider];

  const isSheets = provider === "google_sheets";
  const isShopify = provider === "shopify";
  const [connections, catalog, settings, shopifyGate] = await Promise.all([
    api.connections(ctx),
    api.catalog(ctx),
    api.settings(ctx),
    isShopify ? api.shopifyApp(ctx) : Promise.resolve(null),
  ]);
  const legalAccepted = settings.legalAcceptance !== null;

  // Connect stays disabled while this workspace has no app credentials to
  // install with. The api enforces this authoritatively at the grant-mint and
  // install endpoints (403 shopify_provisioning_required) — this is the
  // matching UX gate so the button isn't a dead link, and so a workspace can
  // never be sent into an OAuth flow on credentials that aren't its own.
  const shopifyState =
    isShopify && shopifyGate !== null
      ? shopifyConnectState(shopifyGate)
      : "available";
  const shopifyUnavailable = shopifyState !== "available";

  const row =
    connections.filter((c) => c.provider === provider)[0] ?? null;
  const tone = !row
    ? "missing"
    : row.status === "active"
      ? "active"
      : "revoked";
  // The renewal/poll crons flag a live connection that's stopped working
  // (signed out, lapsed mailbox subscription, …). When set, we show a "Needs
  // attention" treatment in place of the green active badge.
  const health = tone === "active" ? connectorHealth(row?.metadata) : null;
  const needsAttention = health?.state === "broken";
  const showConnect =
    !!apiBaseUrl && legalAccepted && tone !== "active" && !shopifyUnavailable;
  const disconnectAction =
    provider === "shopify"
      ? disconnectShopifyAction
      : provider === "gmail"
        ? disconnectGmailAction
        : provider === "google_sheets"
          ? disconnectGoogleSheetsAction
          : null;
  const showDisconnect = !!disconnectAction && tone === "active";
  const capabilities = capabilitiesForProvider(catalog, provider);
  const missingCapability =
    !!row &&
    capabilities.some(
      (c) => !isConnectorScopeGranted(provider, c.scope, row.scopes),
    );

  // The Google Sheets connector owns the sheet target the agent writes to
  // (the missing-package supplier-escalation row). It lives here — on the
  // connection itself — rather than on a separate settings page, because
  // it's a property of this connection.
  const sheet = settings?.supplierEscalationSheet ?? null;
  const sheetUrl = sheet
    ? googleSheetsUrlForSpreadsheetId(sheet.spreadsheetId)
    : "";
  const sp = (await searchParams) ?? {};
  const savedBanner = isSheets && firstParam(sp["saved"]) === "1";
  const clearedBanner = isSheets && firstParam(sp["cleared"]) === "1";
  const sheetError = isSheets ? firstParam(sp["error"]) : undefined;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/integrations", label: "Integrations" }]}
        current={label}
      />

      <div>
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <ProviderIcon />
          {label}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {needsAttention ? (
            <Badge variant="destructive">Needs attention</Badge>
          ) : (
            <Badge variant={integrationStatusVariant(tone)}>{tone}</Badge>
          )}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{description}</p>
      </div>

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

      {!legalAccepted ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Legal acceptance required</AlertTitle>
          <AlertDescription>
            Accept the current data processing notice and DPA in{" "}
            <a href="/settings/legal" className="font-medium text-primary hover:underline">
              Settings → Legal
            </a>{" "}
            before connecting or reinstalling providers.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {needsAttention ? (
            <Alert variant="warning">
              <AlertTriangle className="size-4" />
              <AlertTitle>Needs attention — reconnect</AlertTitle>
              <AlertDescription>
                {connectorHealthReasonLabel(health?.reason)}
              </AlertDescription>
            </Alert>
          ) : null}

          {row ? (
            <div className="space-y-1 text-sm">
              {row.shopDomain ? (
                <div>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {row.shopDomain}
                  </code>
                </div>
              ) : null}
              {row.installedAt || row.revokedAt ? (
                <div className="text-xs text-muted-foreground">
                  {[
                    row.installedAt
                      ? `installed ${formatRelativeTime(row.installedAt)}`
                      : null,
                    row.revokedAt
                      ? `revoked ${formatRelativeTime(row.revokedAt)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              Not connected yet.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {/* Reinstall path: active Shopify row with a missing scope.
                Shopify shows the merchant an "update permissions" prompt
                without losing the existing connection. */}
            {provider === "shopify" &&
            row &&
            tone === "active" &&
            apiBaseUrl &&
            legalAccepted &&
            missingCapability ? (
              <Button variant="outline" asChild>
                <a href={connectHref("shopify")}>
                  Reinstall to update scopes
                </a>
              </Button>
            ) : null}

            {/* Reconnect path: a live connection the crons flagged as broken.
                Same install gates as Connect — never start an OAuth flow the
                api would refuse (e.g. an unprovisioned Shopify workspace). */}
            {needsAttention &&
            apiBaseUrl &&
            legalAccepted &&
            !shopifyUnavailable ? (
              <Button asChild>
                <a href={connectHref(provider)}>Reconnect {label}</a>
              </Button>
            ) : null}

            {!legalAccepted && tone !== "active" ? (
              <Button asChild>
                <a href="/settings/legal">Review legal terms</a>
              </Button>
            ) : shopifyUnavailable && tone !== "active" ? (
              <div className="space-y-1.5">
                <Button disabled>Connect {label}</Button>
                <p className="text-xs text-muted-foreground">
                  {shopifyState === "awaiting_provisioning"
                    ? "Awaiting setup — support is provisioning your Shopify app for this workspace. You can connect once it's ready."
                    : "Shopify connections aren't available yet. Please contact support."}
                </p>
              </div>
            ) : showConnect && apiBaseUrl ? (
              <Button asChild>
                <a href={connectHref(provider)}>
                  {tone === "revoked" ? `Reconnect ${label}` : `Connect ${label}`}
                </a>
              </Button>
            ) : null}

            {showDisconnect && disconnectAction ? (
              <form action={disconnectAction}>
                <ConfirmSubmitButton
                  title={`Disconnect ${label}?`}
                  description={
                    provider === "shopify"
                      ? "The agent loses order, customer, and refund access for this store until you reconnect."
                      : provider === "google_sheets"
                        ? "Sheets-backed workflows (like supplier escalation) stop working until you reconnect."
                        : "The agent stops reading and replying to this mailbox immediately. Open cases can't send replies until you reconnect."
                  }
                  confirmLabel="Disconnect"
                >
                  Disconnect {label}
                </ConfirmSubmitButton>
              </form>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Per-capability scope grid, derived from each tool's
          `requiredConnectorScopes` declaration. Surfaces the
          "this scope unlocks this tool" mapping so the operator sees
          if the merchant needs to re-OAuth to pick up a newly-added
          capability. Only renders when there's an active connection AND
          at least one tool declares scopes for this provider. */}
      {row && tone === "active" && capabilities.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Granted capabilities</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            <ul className="space-y-1.5 text-sm">
              {capabilities.map((cap) => {
                const granted = isConnectorScopeGranted(
                  provider,
                  cap.scope,
                  row.scopes,
                );
                return (
                  <li key={cap.tool} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={
                        granted
                          ? "inline-block size-2 rounded-full bg-primary"
                          : "inline-block size-2 rounded-full bg-destructive"
                      }
                    />
                    <span>{cap.label}</span>
                    <span className="sr-only">
                      {granted ? " (granted)" : " (not granted)"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {missingCapability ? (
              <p className="pt-1 text-[11px] leading-snug text-muted-foreground">
                Missing a capability? Click <strong>Reinstall</strong>{" "}
                {provider === "shopify"
                  ? "above — Shopify shows the merchant an “update permissions” prompt without losing the existing connection."
                  : "above to reconnect and grant the latest permissions."}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {isSheets ? (
        <>
          {savedBanner ? (
            <Alert variant="success">
              <AlertDescription>Sheet target saved.</AlertDescription>
            </Alert>
          ) : null}
          {clearedBanner ? (
            <Alert>
              <AlertDescription>
                Sheet target cleared. The agent will skip the sheet write on
                future missing-package cases.
              </AlertDescription>
            </Alert>
          ) : null}
          {sheetError === "missing_sheet_url" ||
          sheetError === "missing_spreadsheet_id" ? (
            <Alert variant="warning">
              <AlertDescription>Google Sheets URL is required.</AlertDescription>
            </Alert>
          ) : null}
          {sheetError === "bad_sheet_url" ? (
            <Alert variant="warning">
              <AlertDescription>
                Paste the URL from a Google Sheet, for example{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  https://docs.google.com/spreadsheets/d/.../edit
                </code>
                .
              </AlertDescription>
            </Alert>
          ) : null}
          {sheetError === "bad_range" ? (
            <Alert variant="warning">
              <AlertDescription>
                Range must be an A1 reference with a sheet name (e.g.{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  Escalations!A:F
                </code>
                ).
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="size-4" aria-hidden />
                Sheet target
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 pt-0">
              <p className="text-sm text-muted-foreground">
                The Google Sheet the missing-package agent writes to via{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  supplier.add_sheet_row
                </code>{" "}
                when a customer reports a package marked delivered that
                didn&apos;t arrive (BRANCH A). The platform writes rows using
                this connection. Leave unset to skip the sheet write entirely.
              </p>

              {tone !== "active" ? (
                <Alert variant="warning">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Connect Google Sheets first</AlertTitle>
                  <AlertDescription>
                    You can save a target below, but the agent can only write
                    once this connection is active.
                  </AlertDescription>
                </Alert>
              ) : null}

              <form action={saveSupplierEscalationAction} className="space-y-4">
                <div className="grid gap-2 sm:max-w-2xl">
                  <Label htmlFor="sheetUrl">Google Sheets URL</Label>
                  <Input
                    id="sheetUrl"
                    name="sheetUrl"
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    defaultValue={sheetUrl}
                    placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                    required
                    aria-describedby="sheet-url-hint"
                  />
                  <p id="sheet-url-hint" className="text-xs text-muted-foreground">
                    Open the Google Sheet and paste the link from the browser
                    address bar. The platform extracts the sheet ID
                    automatically.
                  </p>
                </div>

                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="range">Range</Label>
                  <Input
                    id="range"
                    name="range"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    defaultValue={sheet?.range ?? "Escalations!A:F"}
                    required
                    aria-describedby="range-hint"
                  />
                  <p id="range-hint" className="text-xs text-muted-foreground">
                    A1 reference with sheet name. The agent appends below the
                    last non-empty row inside this column span.
                  </p>
                </div>

                <div className="grid gap-2 sm:max-w-2xl">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    name="description"
                    rows={2}
                    defaultValue={sheet?.description ?? ""}
                    placeholder="Warehouse ops watches this sheet for delivery exceptions."
                  />
                  <p className="text-xs text-muted-foreground">
                    For your team. Not surfaced to the agent or written to the
                    sheet.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button type="submit">Save</Button>
                  {sheet ? (
                    <Button
                      formAction={clearSupplierEscalationAction}
                      type="submit"
                      variant="outline"
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </form>

              <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
                <p className="mb-2 font-medium text-foreground">
                  Columns are yours — the agent reads your header row
                </p>
                <p className="mb-2">
                  You don&apos;t need a fixed layout. When the missing-package
                  agent escalates, it reads the sheet&apos;s header row and
                  fills the columns it recognises by name, leaving the rest
                  blank. Add a header row with any of these (in any order); the
                  agent matches them case-insensitively:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    <strong>Case</strong> / Case ID / Ticket — the support case
                    id
                  </li>
                  <li>
                    <strong>Email</strong> / Customer — the customer&apos;s
                    email
                  </li>
                  <li>
                    <strong>Order</strong> / Order # — the order name (e.g.
                    #1001)
                  </li>
                  <li>
                    <strong>Tracking</strong> — the carrier tracking number
                  </li>
                  <li>
                    <strong>Delivered</strong> / Delivered At — the delivered-at
                    timestamp
                  </li>
                  <li>
                    <strong>Date</strong> / Logged / Reported — when the row was
                    logged
                  </li>
                </ul>
                <p className="mt-2">
                  No header row? The agent falls back to that order,
                  left-to-right.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
