import Link from "next/link";
import { AlertTriangle, Settings2 } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { integrationStatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";

import {
  SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_ICONS,
  getApiBaseUrl,
  connectHref,
} from "./_shared";
import { connectErrorMessage, parseConnectError } from "./connect-error";
import {
  disconnectShopifyAction,
  disconnectGmailAction,
  disconnectGoogleSheetsAction,
  disconnectOutlookAction,
  disconnectImapAction,
} from "./actions";

const DISCONNECT_ACTIONS: Readonly<
  Partial<Record<string, () => Promise<void>>>
> = {
  shopify: disconnectShopifyAction,
  gmail: disconnectGmailAction,
  google_sheets: disconnectGoogleSheetsAction,
  outlook: disconnectOutlookAction,
  imap: disconnectImapAction,
};

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const params = (await searchParams) ?? {};
  // Set by every disconnect action (`?disconnected=<provider>`, U5).
  const disconnectedParam = params["disconnected"];
  const disconnectedValue = Array.isArray(disconnectedParam)
    ? disconnectedParam[0]
    : disconnectedParam;
  const disconnectedLabel = disconnectedValue
    ? (PROVIDER_LABELS[disconnectedValue] ?? null)
    : null;
  // Set by the apps/api OAuth callback when it redirects the merchant back
  // here after a successful connect (`?connected=shopify`, `=gmail`, …).
  const connectedParam = params["connected"];
  const connectedValue = Array.isArray(connectedParam)
    ? connectedParam[0]
    : connectedParam;
  const connectedLabel = connectedValue
    ? (PROVIDER_LABELS[connectedValue] ?? null)
    : null;
  // Set when a connect was refused because a mailbox is already connected
  // for that provider (one mailbox per provider per store).
  const errorParam = params["error"];
  const errorValue = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const alreadyConnected = errorValue === "already_connected";
  // OAuth denial/failure from the api callback: `?error=<provider>:<code>`
  // (U6) — e.g. the merchant clicked Cancel on Google's consent screen.
  const connectError = parseConnectError(errorValue);
  const conflictProviderParam = params["provider"];
  const conflictProvider = Array.isArray(conflictProviderParam)
    ? conflictProviderParam[0]
    : conflictProviderParam;
  const conflictLabel = conflictProvider
    ? (PROVIDER_LABELS[conflictProvider] ?? conflictProvider)
    : "this provider";
  const conflictMailboxParam = params["mailbox"];
  const conflictMailbox = Array.isArray(conflictMailboxParam)
    ? conflictMailboxParam[0]
    : conflictMailboxParam;
  const apiBaseUrl = getApiBaseUrl();

  const [rows, settings, shopifyGate] = await Promise.all([
    api.connections(ctx),
    api.settings(ctx),
    api.shopifyApp(ctx),
  ]);
  const legalAccepted = settings.legalAcceptance !== null;
  // Pilot custom distribution: Shopify Connect stays disabled until an
  // operator has provisioned the tenant's custom app. In SaaS mode
  // `requiresProvisioning` is false, so this never blocks.
  const shopifyAwaitingProvisioning =
    shopifyGate.requiresProvisioning && !shopifyGate.provisioned;

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
          Connect the accounts your agents work with. Click Connect and
          Shopify or Google will ask you to approve access; once you finish,
          the connection shows as active. Open <strong>Manage</strong> to see
          the connected account and what your agents can do with it.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Looking for your AI provider key? It lives on its own page —{" "}
          <Link
            href="/settings/llm"
            className="font-medium text-primary hover:underline"
          >
            Settings → AI provider
          </Link>
          .
        </p>
      </div>

      {disconnectedLabel ? (
        <Alert variant="success">
          <AlertDescription>{disconnectedLabel} disconnected.</AlertDescription>
        </Alert>
      ) : null}

      {connectedLabel ? (
        <Alert variant="success">
          <AlertDescription>{connectedLabel} connected.</AlertDescription>
        </Alert>
      ) : null}

      {connectError ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>
            {PROVIDER_LABELS[connectError.provider] ?? connectError.provider}{" "}
            wasn&apos;t connected
          </AlertTitle>
          <AlertDescription>
            {connectErrorMessage(connectError.code)}
          </AlertDescription>
        </Alert>
      ) : null}

      {alreadyConnected ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>A mailbox is already connected</AlertTitle>
          <AlertDescription>
            Only one {conflictLabel} mailbox can be connected at a time
            {conflictMailbox ? (
              <>
                {" "}
                (currently <strong>{conflictMailbox}</strong>)
              </>
            ) : null}
            . Disconnect it below before connecting a different one.
          </AlertDescription>
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
                          <ConfirmSubmitButton
                            title={`Disconnect ${label}?`}
                            description={
                              p === "shopify"
                                ? "The agent loses order, customer, and refund access for this store until you reconnect."
                                : p === "google_sheets"
                                  ? "Sheets-backed workflows (like supplier escalation) stop working until you reconnect."
                                  : "The agent stops reading and replying to this mailbox immediately. Open cases can't send replies until you reconnect."
                            }
                            confirmLabel="Disconnect"
                          >
                            Disconnect
                          </ConfirmSubmitButton>
                        </form>
                      ) : null}
                    </>
                  ) : !legalAccepted ? (
                    <Button asChild>
                      <Link href="/settings/legal">Review legal terms</Link>
                    </Button>
                  ) : p === "shopify" && shopifyAwaitingProvisioning ? (
                    <div className="space-y-1.5">
                      <Button disabled>Connect {label}</Button>
                      <p className="text-xs text-muted-foreground">
                        Awaiting setup — support is provisioning your Shopify
                        app. You can connect once it&apos;s ready.
                      </p>
                    </div>
                  ) : apiBaseUrl ? (
                    <Button asChild>
                      <a
                        href={connectHref(p)}
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
    </div>
  );
}
