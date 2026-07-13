import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  connectorHealth,
  connectorHealthReasonLabel,
} from "@/lib/connector-health";
import { integrationStatusVariant } from "@/lib/status-variants";
import { connectRedirectUrl } from "@/lib/connect-redirect";
import {
  connectErrorMessage,
  connectedBanner,
  parseConnectError,
  shopifyConnectState,
  type ShopifyConnectState,
} from "@/lib/connect-error";
import {
  SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
  isBetaProvider,
  type SupportedProvider,
} from "@/lib/integration-providers";
import type { ResolvedToast } from "@/lib/toast-feedback";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { Link } from "@/components/ui/link";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";

import gmailLogo from "./logos/gmail.svg";
import googleSheetsLogo from "./logos/google-sheets.svg";
import outlookLogo from "./logos/outlook.svg";

// ============================================================
// Provider brand icons (the React/asset half of the Next _shared.tsx)
// ============================================================

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
  <img
    src={gmailLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

const GoogleSheetsIcon = () => (
  <img
    src={googleSheetsLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

const OutlookIcon = () => (
  <img
    src={outlookLogo}
    alt=""
    className="size-5 shrink-0 object-contain"
    aria-hidden
  />
);

// Generic mail glyph — IMAP/SMTP is a protocol, not a brand.
const ImapIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    className="size-5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="m3.5 6.5 8.5 6 8.5-6" />
  </svg>
);

export const PROVIDER_ICONS = {
  shopify: ShopifyIcon,
  gmail: GmailIcon,
  google_sheets: GoogleSheetsIcon,
  outlook: OutlookIcon,
  imap: ImapIcon,
} satisfies Readonly<Record<SupportedProvider, () => ReactNode>>;

// The api origin the SPA talks to. Always present in a working deployment (the
// api-client throws without it), but we mirror the Next "Connect buttons
// disabled" alert for the misconfigured ticket.
const apiBaseUrl: string | null = ((): string | null => {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (!raw || raw.trim().length === 0) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
})();

// ============================================================
// Connect / Disconnect controls (server-action forms → client mutations)
// ============================================================

/**
 * Connect / Reconnect. For OAuth providers this mints a short-lived signed
 * install grant server-side (POST /dashboard/connect/:provider) then redirects
 * the browser to the provider OAuth — the tenant is derived from the session,
 * never client-supplied. IMAP/SMTP has no OAuth redirect; its connect + discover
 * flow lives on the per-connector manage page.
 */
function ConnectButton({
  provider,
  label,
  children,
}: {
  readonly provider: SupportedProvider;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const ctx = useWorkspaceCtx();
  const mint = useMutation({
    mutationFn: () => api.connectUrl(ctx, provider),
    onSuccess: (res) => {
      if ("url" in res) {
        window.location.assign(connectRedirectUrl(res.url, provider, null));
        return;
      }
      if ("alreadyConnected" in res) {
        const mailbox = res.alreadyConnected.mailbox;
        toast.warning("A mailbox is already connected", {
          description: `Only one ${label} mailbox can be connected at a time${
            mailbox ? ` (currently ${mailbox})` : ""
          }. Disconnect it below before connecting a different one.`,
        });
        return;
      }
      toast.warning(`${label} wasn't connected`, {
        description: connectErrorMessage(res.denied),
      });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  if (provider === "imap") {
    return (
      <Button asChild>
        <Link href="/settings/integrations/imap">{children}</Link>
      </Button>
    );
  }
  return (
    <Button onClick={() => mint.mutate()} disabled={mint.isPending}>
      {mint.isPending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : null}
      {children}
    </Button>
  );
}

/** Disconnect a connected provider (confirm dialog → POST disconnect). */
function DisconnectButton({
  provider,
  label,
}: {
  readonly provider: SupportedProvider;
  readonly label: string;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.disconnect(ctx, provider),
    onSuccess: () => {
      toast.success(`${label} disconnected.`);
      void qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.shopifyApp(ctx.workspaceId) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });
  const description =
    provider === "shopify"
      ? "The agent loses order, customer, and refund access for this store until you reconnect."
      : provider === "google_sheets"
        ? "Sheets-backed workflows (like fulfillment partner escalation) stop working until you reconnect."
        : "The agent stops reading and replying to this mailbox immediately. Open tickets can't send replies until you reconnect.";
  return (
    <ConfirmButton
      variant="destructive"
      title={`Disconnect ${label}?`}
      description={description}
      confirmLabel="Disconnect"
      pending={m.isPending}
      onConfirm={() => m.mutate()}
    >
      Disconnect
    </ConfirmButton>
  );
}

/** Card-grid skeleton painted while connections/settings/gate queries resolve. */
function IntegrationsLoading() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2"
      aria-busy
      aria-label="Loading integrations"
    >
      {SUPPORTED_PROVIDERS.map((p) => (
        <Card key={p}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-5 rounded" />
                <Skeleton className="h-5 w-28" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-9 w-36 rounded-md" />
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function IntegrationsPage() {
  const allowed = useRequirePermission("settings.integrations");
  const ctx = useWorkspaceCtx();

  const connectionsQ = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
    enabled: allowed,
  });
  const settingsQ = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });
  const shopifyAppQ = useQuery({
    queryKey: qk.shopifyApp(ctx.workspaceId),
    queryFn: () => api.shopifyApp(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const loading =
    connectionsQ.isLoading || settingsQ.isLoading || shopifyAppQ.isLoading;

  const rows = connectionsQ.data ?? [];
  const settings = settingsQ.data;
  const shopifyGate = shopifyAppQ.data;
  const legalAccepted = settings ? settings.legalAcceptance !== null : false;
  const shopifyState: ShopifyConnectState = shopifyGate
    ? shopifyConnectState(shopifyGate)
    : "available";

  const byProvider = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, r);
  }

  // Post-OAuth-round-trip feedback: the api callback redirects back here with
  // `?connected=<provider>` on success or `?error=<provider>:<code>` on a
  // cancelled/failed consent. (Disconnect now toasts directly from its
  // mutation, so there's no `?disconnected` param.) The success banner is only
  // trusted when THIS workspace actually holds an active row.
  const search = new URLSearchParams(window.location.search);
  const connectedValue = search.get("connected") ?? undefined;
  const errorValue = search.get("error") ?? undefined;
  const alreadyConnected = errorValue === "already_connected";
  const connectError = parseConnectError(errorValue);
  const conflictProvider = search.get("provider") ?? undefined;
  const conflictLabel = conflictProvider
    ? (PROVIDER_LABELS[conflictProvider] ?? conflictProvider)
    : "this provider";
  const conflictMailbox = search.get("mailbox") ?? undefined;
  const connectedOutcome = connectedBanner(
    connectedValue,
    connectedValue ? byProvider.get(connectedValue)?.status : undefined,
  );

  const feedbackToasts: ResolvedToast[] = [];
  const feedbackConsume: string[] = [];
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
          Connect the accounts your agents work with. Click Connect and Shopify
          or Google will ask you to approve access; once you finish, the
          connection shows as active. Open <strong>Manage</strong> to see the
          connected account and what your agents can do with it.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Looking for your AI provider key? It lives on its own page:{" "}
          <Link
            href="/settings/llm"
            className="font-medium text-primary hover:underline"
          >
            Settings → AI provider
          </Link>
          .
        </p>
      </div>

      {loading ? (
        <IntegrationsLoading />
      ) : (
        <>
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
                  VITE_API_BASE_URL
                </code>{" "}
                to the public origin of{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  apps/api
                </code>{" "}
                and rebuild.
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

              return (
                <Card key={p}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <ProviderIcon />
                        {label}
                        {isBetaProvider(p) ? (
                          <Badge
                            variant="info"
                            icon={false}
                            className="px-2 py-0 font-medium"
                          >
                            Beta
                          </Badge>
                        ) : null}
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
                        <AlertTitle>Needs attention: reconnect</AlertTitle>
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
                            <ConnectButton provider={p} label={label}>
                              Reconnect {label}
                            </ConnectButton>
                          ) : null}
                          <Button variant="outline" asChild>
                            <Link href={`/settings/integrations/${p}`}>
                              <Settings2 className="size-3.5" aria-hidden />
                              Manage
                            </Link>
                          </Button>
                          <DisconnectButton provider={p} label={label} />
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
                              ? "Awaiting setup. Support is provisioning your Shopify app for this workspace. You can connect once it's ready."
                              : "Shopify connections aren't available yet. Please contact support."}
                          </p>
                        </div>
                      ) : apiBaseUrl ? (
                        <ConnectButton provider={p} label={label}>
                          {tone === "revoked"
                            ? `Reconnect ${label}`
                            : `Connect ${label}`}
                        </ConnectButton>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
