import Link from "next/link";
import { AlertTriangle, Settings2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { requirePermission } from "@/lib/require-permission";
import {
  connectorHealth,
  connectorHealthReasonLabel,
} from "@/lib/connector-health";
import { integrationStatusVariant } from "@/lib/status-variants";
import type { ResolvedToast } from "@/lib/toast-feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";

import {
  SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_ICONS,
  getApiBaseUrl,
  connectHref,
} from "./_shared";
import {
  connectErrorMessage,
  connectedBanner,
  parseConnectError,
  shopifyConnectState,
} from "./connect-error";
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
  const ctx = await requirePermission("settings.integrations");
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
  // Only trusted as a breadcrumb — the banner below checks this workspace's
  // actual connections before claiming success.
  const connectedParam = params["connected"];
  const connectedValue = Array.isArray(connectedParam)
    ? connectedParam[0]
    : connectedParam;
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
  // Connect stays disabled while this workspace has no app credentials to
  // install with: a pilot workspace whose custom app isn't provisioned (or
  // was revoked), or a deployment with no Shopify app configured at all.
  // `available` mirrors the api's own install gate, so the button can never
  // start a flow the api would refuse — or one that could only run on
  // another store's credentials.
  const shopifyState = shopifyConnectState(shopifyGate);

  const byProvider = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, r);
  }

  // The success banner must be true for THIS workspace, not just echoed from
  // the redirect: a connect that completed against a different workspace
  // used to land here as "connected." while the card still said missing.
  const connectedOutcome = connectedBanner(
    connectedValue,
    connectedValue ? byProvider.get(connectedValue)?.status : undefined,
  );

  // Post-redirect feedback (disconnect, OAuth-callback connect outcome, connect
  // refusals) is shown as toasts; the persistent state below (legal, no API
  // origin, per-card "needs attention") stays inline.
  const feedbackToasts: ResolvedToast[] = [];
  const feedbackConsume: string[] = [];
  if (disconnectedLabel) {
    feedbackToasts.push({
      kind: "success",
      message: `${disconnectedLabel} disconnected.`,
    });
    feedbackConsume.push("disconnected");
  }
  if (connectedOutcome?.kind === "connected") {
    feedbackToasts.push({
      kind: "success",
      message: `${connectedOutcome.label} connected.`,
    });
    feedbackConsume.push("connected");
  } else if (connectedOutcome?.kind === "not_landed") {
    feedbackToasts.push({
      kind: "warning",
      message: `${connectedOutcome.label} isn't connected in this workspace`,
      description:
        "The connection finished, but it didn't end up in this workspace. If you manage more than one workspace, check whether it landed in another one before trying again.",
    });
    feedbackConsume.push("connected");
  }
  if (connectError) {
    feedbackToasts.push({
      kind: "warning",
      message: `${PROVIDER_LABELS[connectError.provider] ?? connectError.provider} wasn't connected`,
      description: connectErrorMessage(connectError.code),
    });
    feedbackConsume.push("error");
  } else if (alreadyConnected) {
    feedbackToasts.push({
      kind: "warning",
      message: "A mailbox is already connected",
      description: `Only one ${conflictLabel} mailbox can be connected at a time${
        conflictMailbox ? ` (currently ${conflictMailbox})` : ""
      }. Disconnect it below before connecting a different one.`,
    });
    feedbackConsume.push("error", "provider", "mailbox");
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

      <FeedbackToaster toasts={feedbackToasts} consume={feedbackConsume} />

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
          // The renewal/poll crons flag a live connection that's stopped
          // working (signed out, lapsed mailbox subscription, …). Surface it
          // as a clear "Needs attention" treatment instead of the green
          // active badge so the merchant knows to reconnect.
          const health = isActive ? connectorHealth(row?.metadata) : null;
          const needsAttention = health?.state === "broken";
          const disconnectAction = DISCONNECT_ACTIONS[p];

          return (
            <Card key={p}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ProviderIcon />
                    {label}
                  </CardTitle>
                  {needsAttention ? (
                    <Badge variant="destructive">Needs attention</Badge>
                  ) : (
                    <Badge variant={integrationStatusVariant(tone)}>
                      {tone}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {needsAttention ? (
                  <Alert variant="warning">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Needs attention — reconnect</AlertTitle>
                    <AlertDescription>
                      {connectorHealthReasonLabel(health?.reason)}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {isActive ? (
                    <>
                      {needsAttention &&
                      apiBaseUrl &&
                      legalAccepted &&
                      !(p === "shopify" && shopifyState !== "available") ? (
                        <Button asChild>
                          <a href={connectHref(p)}>Reconnect {label}</a>
                        </Button>
                      ) : null}
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
                                  : "The agent stops reading and replying to this mailbox immediately. Open tickets can't send replies until you reconnect."
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
                  ) : p === "shopify" && shopifyState !== "available" ? (
                    <div className="space-y-1.5">
                      <Button disabled>Connect {label}</Button>
                      <p className="text-xs text-muted-foreground">
                        {shopifyState === "awaiting_provisioning"
                          ? "Awaiting setup — support is provisioning your Shopify app for this workspace. You can connect once it's ready."
                          : "Shopify connections aren't available yet. Please contact support."}
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
