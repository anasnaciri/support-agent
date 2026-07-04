import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertTriangle, ClipboardList, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import type { SupplierEscalationSheetView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { useAppNavigate } from "@/lib/navigation";
import {
  capabilitiesForProvider,
  isCapabilityGranted,
  platformCapabilitiesForProvider,
} from "@/lib/catalog";
import {
  connectorHealth,
  connectorHealthReasonLabel,
} from "@/lib/connector-health";
import { formatRelativeTime } from "@/lib/format";
import { integrationStatusVariant } from "@/lib/status-variants";
import { connectRedirectUrl } from "@/lib/connect-redirect";
import {
  connectErrorMessage,
  shopifyConnectState,
  type ShopifyConnectState,
} from "@/lib/connect-error";
import {
  PROVIDER_LABELS,
  PROVIDER_DESCRIPTIONS,
  isSupportedProvider,
  type SupportedProvider,
} from "@/lib/integration-providers";
import {
  extractGoogleSheetsSpreadsheetId,
  googleSheetsUrlForSpreadsheetId,
} from "@/lib/sheet-url";
import {
  friendlyConnectDetail,
  passwordGuidanceForFailure,
  planImapConnect,
  type DiscoveredPrefill,
  type ImapDiscoveryResponse,
  type ImapFormValues,
} from "@/lib/connect-plan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Link } from "@/components/ui/link";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

import { PROVIDER_ICONS } from "./IntegrationsPage";

// The api origin the SPA talks to. Always present in a working deployment; the
// misconfigured ticket mirrors the Next "Connect buttons disabled" alert.
const apiBaseUrl: string | null = ((): string | null => {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (!raw || raw.trim().length === 0) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
})();

// A1 reference with mandatory sheet-name prefix (permissive on the column
// span). Forbids only the `!` separator inside the sheet name.
const RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

// ============================================================
// Connect / Disconnect controls (OAuth connectors only — IMAP has its own form)
// ============================================================

/**
 * Connect / Reconnect / Reinstall an OAuth connector: mint a short-lived signed
 * install grant server-side, then redirect the browser to the provider OAuth.
 */
function OAuthConnectButton({
  provider,
  label,
  variant,
  children,
}: {
  readonly provider: SupportedProvider;
  readonly label: string;
  readonly variant?: "outline";
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
          }. Disconnect it first before connecting a different one.`,
        });
        return;
      }
      toast.warning(`${label} wasn't connected`, {
        description: connectErrorMessage(res.denied),
      });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });
  return (
    <Button
      {...(variant ? { variant } : {})}
      onClick={() => mint.mutate()}
      disabled={mint.isPending}
    >
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
  children,
}: {
  readonly provider: SupportedProvider;
  readonly label: string;
  readonly children: ReactNode;
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
        ? "Sheets-backed workflows (like supplier escalation) stop working until you reconnect."
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
      {children}
    </ConfirmButton>
  );
}

// ============================================================
// Google Sheets — the sheet target the missing-package agent writes to
// ============================================================

function SheetTargetForm({
  tone,
  sheet,
}: {
  readonly tone: string;
  readonly sheet: SupplierEscalationSheetView | null;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [sheetUrl, setSheetUrl] = useState(() =>
    sheet ? googleSheetsUrlForSpreadsheetId(sheet.spreadsheetId) : "",
  );
  const [range, setRange] = useState(() => sheet?.range ?? "Escalations!A:F");
  const [description, setDescription] = useState(() => sheet?.description ?? "");

  const saveM = useMutation({
    mutationFn: (input: {
      readonly spreadsheetId: string;
      readonly range: string;
      readonly description: string | null;
    }) => api.setSupplierSheet(ctx, input),
    onSuccess: () => {
      toast.success("Sheet target saved.");
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const clearM = useMutation({
    mutationFn: () => api.clearSupplierSheet(ctx),
    onSuccess: () => {
      toast(
        "Sheet target cleared. The agent will skip the sheet write on future missing-package tickets.",
      );
      setSheetUrl("");
      setRange("Escalations!A:F");
      setDescription("");
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Client-side mirror of the server action's validation (it redirected with
    // `?error=...` per branch; we toast the same copy before mutating).
    const url = sheetUrl.trim();
    if (url.length === 0) {
      toast.warning("Google Sheets URL is required.");
      return;
    }
    const spreadsheetId = extractGoogleSheetsSpreadsheetId(url);
    if (!spreadsheetId) {
      toast.warning(
        "Paste the URL from a Google Sheet, for example https://docs.google.com/spreadsheets/d/.../edit.",
      );
      return;
    }
    const trimmedRange = range.trim();
    if (!RANGE_RE.test(trimmedRange)) {
      toast.warning(
        "Range must be an A1 reference with a sheet name (e.g. Escalations!A:F).",
      );
      return;
    }
    const trimmedDescription = description.trim();
    saveM.mutate({
      spreadsheetId,
      range: trimmedRange,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
    });
  };

  const pending = saveM.isPending || clearM.isPending;

  return (
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
          when a customer reports a package marked delivered that didn&apos;t
          arrive (BRANCH A). The platform writes rows using this connection.
          Leave unset to skip the sheet write entirely.
        </p>

        {tone !== "active" ? (
          <Alert variant="warning">
            <AlertTriangle className="size-4" />
            <AlertTitle>Connect Google Sheets first</AlertTitle>
            <AlertDescription>
              You can save a target below, but the agent can only write once
              this connection is active.
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2 sm:max-w-2xl">
            <Label htmlFor="sheetUrl">Google Sheets URL</Label>
            <Input
              id="sheetUrl"
              name="sheetUrl"
              type="text"
              inputMode="url"
              autoComplete="off"
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.currentTarget.value)}
              placeholder="https://docs.google.com/spreadsheets/d/.../edit"
              aria-describedby="sheet-url-hint"
            />
            <p id="sheet-url-hint" className="text-xs text-muted-foreground">
              Open the Google Sheet and paste the link from the browser address
              bar. The platform extracts the sheet ID automatically.
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
              value={range}
              onChange={(e) => setRange(e.currentTarget.value)}
              aria-describedby="range-hint"
            />
            <p id="range-hint" className="text-xs text-muted-foreground">
              A1 reference with sheet name. The agent appends below the last
              non-empty row inside this column span.
            </p>
          </div>

          <div className="grid gap-2 sm:max-w-2xl">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              name="description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              placeholder="Warehouse ops watches this sheet for delivery exceptions."
            />
            <p className="text-xs text-muted-foreground">
              For your team. Not surfaced to the agent or written to the sheet.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {saveM.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Save
            </Button>
            {sheet ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => clearM.mutate()}
              >
                {clearM.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
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
            You don&apos;t need a fixed layout. When the missing-package agent
            escalates, it reads the sheet&apos;s header row and fills the columns
            it recognises by name, leaving the rest blank. Add a header row with
            any of these (in any order); the agent matches them
            case-insensitively:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Ticket</strong> / Ticket ID / Ticket — the support ticket id
            </li>
            <li>
              <strong>Email</strong> / Customer — the customer&apos;s email
            </li>
            <li>
              <strong>Order</strong> / Order # — the order name (e.g. #1001)
            </li>
            <li>
              <strong>Tracking</strong> — the carrier tracking number
            </li>
            <li>
              <strong>Delivered</strong> / Delivered At — the delivered-at
              timestamp
            </li>
            <li>
              <strong>Date</strong> / Logged / Reported — when the row was logged
            </li>
          </ul>
          <p className="mt-2">
            No header row? The agent falls back to that order, left-to-right.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// IMAP / SMTP — connect + discover flow (the Next /connect/imap form, inlined)
// ============================================================

interface ImapConnectState {
  readonly error:
    | "missing_fields"
    | "missing_hosts"
    | "needs_server_settings"
    | "use_oauth_connector"
    | "imap_connect_failed"
    | "imap_already_connected"
    | "legal_acceptance_required"
    | "unexpected";
  readonly detail?: string;
  readonly mailbox?: string;
  readonly provider?: "google" | "outlook";
  readonly discovered?: DiscoveredPrefill;
}

type ImapOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "state"; readonly state: ImapConnectState };

const OAUTH_LABEL = { google: "Google", outlook: "Microsoft" } as const;

function ImapConnectForm() {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const nav = useAppNavigate();

  const [state, setState] = useState<ImapConnectState | null>(null);
  const [advancedToggled, setAdvancedToggled] = useState(false);
  const [mailbox, setMailbox] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("");
  const [imapSecure, setImapSecure] = useState("true");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [smtpSecure, setSmtpSecure] = useState("true");

  const m = useMutation<ImapOutcome>({
    mutationFn: async (): Promise<ImapOutcome> => {
      const values: ImapFormValues = {
        mailbox,
        password,
        user,
        imapHost,
        imapPort,
        imapSecure,
        smtpHost,
        smtpPort,
        smtpSecure,
      };
      const plan = await planImapConnect(values, async (email) => {
        const res = await api.discoverImap(ctx, { email });
        return res.status === 200 ? (res.body as ImapDiscoveryResponse) : null;
      });
      if (plan.action === "error") {
        return { kind: "state", state: { error: plan.error } };
      }
      if (plan.action === "oauth") {
        return {
          kind: "state",
          state: { error: "use_oauth_connector", provider: plan.provider },
        };
      }
      if (plan.action === "needs_settings") {
        return { kind: "state", state: { error: "needs_server_settings" } };
      }
      const res = await api.connectImap(ctx, plan.input);
      if (res.status === 403) {
        return { kind: "state", state: { error: "legal_acceptance_required" } };
      }
      if (res.status === 409) {
        const body = res.body as { mailbox?: string } | null;
        return {
          kind: "state",
          state: {
            error: "imap_already_connected",
            ...(body?.mailbox ? { mailbox: body.mailbox } : {}),
          },
        };
      }
      if (res.status === 400) {
        const body = res.body as { detail?: string } | null;
        const detail = friendlyConnectDetail(body?.detail);
        return {
          kind: "state",
          state: {
            error: "imap_connect_failed",
            ...(detail ? { detail } : {}),
            ...(plan.discovered ? { discovered: plan.discovered } : {}),
          },
        };
      }
      if (res.status !== 200) {
        return { kind: "state", state: { error: "unexpected" } };
      }
      return { kind: "connected" };
    },
    onSuccess: (o) => {
      if (o.kind === "connected") {
        setState(null);
        toast.success("IMAP / SMTP connected.");
        void qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) });
        nav.push("/settings/integrations");
        return;
      }
      // A failed connectivity check with discovered settings: open + prefill
      // the Advanced section so the merchant can adjust and retry.
      if (o.state.error === "imap_connect_failed" && o.state.discovered) {
        const s = o.state.discovered.settings;
        setImapHost(s.imapHost);
        setImapPort(String(s.imapPort));
        setImapSecure(String(s.imapSecure));
        setSmtpHost(s.smtpHost);
        setSmtpPort(String(s.smtpPort));
        setSmtpSecure(String(s.smtpSecure));
        if (s.username) setUser(s.username);
      }
      setState(o.state);
    },
    onError: () => setState({ error: "unexpected" }),
  });

  const pending = m.isPending;
  const discovered =
    state?.error === "imap_connect_failed" ? state.discovered : undefined;
  const needsAdvanced =
    state?.error === "needs_server_settings" ||
    state?.error === "missing_hosts" ||
    discovered !== undefined;
  const failureGuidance =
    state?.error === "imap_connect_failed"
      ? passwordGuidanceForFailure(discovered ?? null)
      : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4" aria-hidden />
          Mailbox credentials
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="mb-5 text-sm text-muted-foreground">
          Enter the address and its <strong>password</strong>; we detect the
          server settings automatically and verify the login before saving. Some
          providers need an app password instead — we&apos;ll tell you if yours
          does. The password is stored encrypted.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-5"
        >
          {state?.error === "missing_fields" ? (
            <Alert variant="warning">
              <AlertDescription>
                Email address and password are required.
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "missing_hosts" ? (
            <Alert variant="warning">
              <AlertDescription>
                Enter both server addresses — incoming and outgoing — or clear
                them both to let us detect them for you.
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "use_oauth_connector" && state.provider ? (
            <Alert variant="warning">
              <AlertTitle>
                Use the {OAUTH_LABEL[state.provider]} connector instead
              </AlertTitle>
              <AlertDescription>
                This address is hosted by {OAUTH_LABEL[state.provider]} — connect
                it with one click from{" "}
                <Link
                  href="/settings/integrations"
                  className="font-medium text-primary hover:underline"
                >
                  Settings → Integrations
                </Link>
                , no app password needed. (Prefer to connect it here anyway? Fill
                in the server settings below.)
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "needs_server_settings" ? (
            <Alert variant="warning">
              <AlertTitle>We couldn&apos;t detect your provider</AlertTitle>
              <AlertDescription>
                Enter the server settings below. You&apos;ll find them in your
                email provider&apos;s help pages — search for &quot;IMAP
                settings&quot;.
              </AlertDescription>
            </Alert>
          ) : null}
          {failureGuidance ? (
            <Alert variant="warning">
              <AlertTitle>Couldn&apos;t sign in</AlertTitle>
              <AlertDescription>
                {failureGuidance.message}{" "}
                {failureGuidance.link ? (
                  <a
                    href={failureGuidance.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    {failureGuidance.link.label}
                  </a>
                ) : null}
                {state?.detail ? (
                  <span className="mt-1 block text-xs opacity-90">
                    {state.detail}
                  </span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "imap_already_connected" ? (
            <Alert variant="warning">
              <AlertTitle>A mailbox is already connected</AlertTitle>
              <AlertDescription>
                This store is already connected to{" "}
                <strong>{state.mailbox ?? "another mailbox"}</strong>. One IMAP
                mailbox per store — disconnect it in{" "}
                <Link
                  href="/settings/integrations"
                  className="font-medium text-primary hover:underline"
                >
                  Settings → Integrations
                </Link>{" "}
                before connecting a different one. Re-submitting the same address
                updates its password and server settings.
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "legal_acceptance_required" ? (
            <Alert variant="warning">
              <AlertDescription>
                Accept the current data processing notice in{" "}
                <Link
                  href="/settings/legal"
                  className="font-medium text-primary hover:underline"
                >
                  Settings → Legal
                </Link>{" "}
                before connecting a mailbox.
              </AlertDescription>
            </Alert>
          ) : null}
          {state?.error === "unexpected" ? (
            <Alert variant="warning">
              <AlertDescription>
                Something went wrong saving the connection. Please try again.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="mailbox">Email address</Label>
            <Input
              id="mailbox"
              name="mailbox"
              type="email"
              autoComplete="off"
              placeholder="support@yourdomain.com"
              required
              disabled={pending}
              value={mailbox}
              onChange={(e) => setMailbox(e.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">
              The address customers email. Replies are sent from here.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="off"
              required
              disabled={pending}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">
              Your mailbox password. Some providers (Fastmail, Zoho, Yahoo,
              iCloud…) need an app password created in their security settings
              instead — we&apos;ll tell you if yours does.
            </p>
          </div>

          <details
            open={advancedToggled || needsAdvanced}
            onToggle={(e) => setAdvancedToggled(e.currentTarget.open)}
            className="rounded-md border"
          >
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
              Server settings{" "}
              <span className="font-normal text-muted-foreground">
                (advanced — detected automatically)
              </span>
            </summary>
            <div className="space-y-4 border-t p-4">
              <div className="grid gap-2">
                <Label htmlFor="user">
                  Login username{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="user"
                  name="user"
                  autoComplete="off"
                  placeholder="Defaults to the email address"
                  disabled={pending}
                  value={user}
                  onChange={(e) => setUser(e.currentTarget.value)}
                />
              </div>

              <fieldset
                className="grid gap-3 rounded-md border p-4"
                disabled={pending}
              >
                <legend className="px-1 text-sm font-medium">
                  Incoming mail (IMAP)
                </legend>
                <div className="grid grid-cols-[1fr_7rem] gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="imapHost">Host</Label>
                    <Input
                      id="imapHost"
                      name="imapHost"
                      placeholder="imap.yourprovider.com"
                      value={imapHost}
                      onChange={(e) => setImapHost(e.currentTarget.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="imapPort">Port</Label>
                    <Input
                      id="imapPort"
                      name="imapPort"
                      type="number"
                      value={imapPort}
                      onChange={(e) => setImapPort(e.currentTarget.value)}
                      placeholder="993"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="imapSecure">Security</Label>
                  <NativeSelect
                    id="imapSecure"
                    name="imapSecure"
                    value={imapSecure}
                    onChange={(e) => setImapSecure(e.currentTarget.value)}
                  >
                    <option value="true">TLS / SSL (port 993)</option>
                    <option value="false">STARTTLS (port 143)</option>
                  </NativeSelect>
                </div>
              </fieldset>

              <fieldset
                className="grid gap-3 rounded-md border p-4"
                disabled={pending}
              >
                <legend className="px-1 text-sm font-medium">
                  Outgoing mail (SMTP)
                </legend>
                <div className="grid grid-cols-[1fr_7rem] gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="smtpHost">Host</Label>
                    <Input
                      id="smtpHost"
                      name="smtpHost"
                      placeholder="smtp.yourprovider.com"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.currentTarget.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="smtpPort">Port</Label>
                    <Input
                      id="smtpPort"
                      name="smtpPort"
                      type="number"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.currentTarget.value)}
                      placeholder="465"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="smtpSecure">Security</Label>
                  <NativeSelect
                    id="smtpSecure"
                    name="smtpSecure"
                    value={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.currentTarget.value)}
                  >
                    <option value="true">TLS / SSL (port 465)</option>
                    <option value="false">STARTTLS (port 587)</option>
                  </NativeSelect>
                </div>
              </fieldset>
            </div>
          </details>

          <Button type="submit" disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {pending ? "Finding your provider & verifying…" : "Connect mailbox"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function IntegrationDetailPage() {
  const allowed = useRequirePermission("settings.integrations");
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const provider = (params as { provider?: string }).provider ?? "";
  const isShopify = provider === "shopify";
  const isSheets = provider === "google_sheets";

  const connectionsQ = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
    enabled: allowed,
  });
  const catalogQ = useQuery({
    queryKey: qk.catalog(ctx.workspaceId),
    queryFn: () => api.catalog(ctx),
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
    enabled: allowed && isShopify,
  });

  if (!allowed) return null;

  if (!isSupportedProvider(provider)) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Connector not found</p>
        <Link
          href="/settings/integrations"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to integrations
        </Link>
      </div>
    );
  }

  const loading =
    connectionsQ.isLoading ||
    catalogQ.isLoading ||
    settingsQ.isLoading ||
    (isShopify && shopifyAppQ.isLoading);

  const settings = settingsQ.data;
  if (loading || !settings) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumb
          items={[{ href: "/settings/integrations", label: "Integrations" }]}
          current={PROVIDER_LABELS[provider] ?? provider}
        />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const label = PROVIDER_LABELS[provider] ?? provider;
  const description = PROVIDER_DESCRIPTIONS[provider] ?? "";
  const ProviderIcon = PROVIDER_ICONS[provider];

  const connections = connectionsQ.data ?? [];
  const catalog = catalogQ.data;
  const shopifyGate = isShopify ? (shopifyAppQ.data ?? null) : null;
  const legalAccepted = settings.legalAcceptance !== null;

  // Connect stays disabled while this workspace has no app credentials to
  // install with. The api enforces this authoritatively; this is the matching
  // UX gate so the button isn't a dead link.
  const shopifyState: ShopifyConnectState =
    isShopify && shopifyGate !== null
      ? shopifyConnectState(shopifyGate)
      : "available";
  const shopifyUnavailable = shopifyState !== "available";

  const row = connections.filter((c) => c.provider === provider)[0] ?? null;
  const tone = !row
    ? "missing"
    : row.status === "active"
      ? "active"
      : "revoked";
  const health = tone === "active" ? connectorHealth(row?.metadata) : null;
  const needsAttention = health?.state === "broken";
  const showConnect =
    !!apiBaseUrl && legalAccepted && tone !== "active" && !shopifyUnavailable;
  const canDisconnect =
    provider === "shopify" ||
    provider === "gmail" ||
    provider === "google_sheets";
  const showDisconnect = canDisconnect && tone === "active";
  const capabilities = [
    ...(catalog ? capabilitiesForProvider(catalog, provider) : []),
    ...platformCapabilitiesForProvider(provider),
  ];
  const missingCapability =
    !!row &&
    capabilities.some((c) => !isCapabilityGranted(provider, c, row.scopes));

  // IMAP/SMTP has no OAuth redirect — its connect + discover form lives here.
  // Show it whenever the connection isn't healthy-active (connect or reconnect;
  // re-submitting the same address updates its password and server settings).
  const showImapForm = provider === "imap" && (tone !== "active" || needsAttention);

  const sheet = settings.supplierEscalationSheet ?? null;

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
            {/* Reinstall path: active Shopify row with a missing scope. Shopify
                shows the merchant an "update permissions" prompt without losing
                the existing connection. */}
            {provider === "shopify" &&
            row &&
            tone === "active" &&
            apiBaseUrl &&
            legalAccepted &&
            missingCapability ? (
              <OAuthConnectButton
                provider="shopify"
                label={label}
                variant="outline"
              >
                Reinstall to update scopes
              </OAuthConnectButton>
            ) : null}

            {/* Reconnect path: a live connection the crons flagged as broken.
                IMAP is handled by its own form below. */}
            {needsAttention &&
            apiBaseUrl &&
            legalAccepted &&
            !shopifyUnavailable &&
            provider !== "imap" ? (
              <OAuthConnectButton provider={provider} label={label}>
                Reconnect {label}
              </OAuthConnectButton>
            ) : null}

            {!legalAccepted && tone !== "active" ? (
              <Button asChild>
                <Link href="/settings/legal">Review legal terms</Link>
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
            ) : showConnect && apiBaseUrl && provider !== "imap" ? (
              <OAuthConnectButton provider={provider} label={label}>
                {tone === "revoked" ? `Reconnect ${label}` : `Connect ${label}`}
              </OAuthConnectButton>
            ) : null}

            {showDisconnect ? (
              <DisconnectButton provider={provider} label={label}>
                Disconnect {label}
              </DisconnectButton>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Per-capability scope grid, derived from each tool's
          `requiredConnectorScopes` declaration. Only renders when there's an
          active connection AND at least one capability for this provider. */}
      {row && tone === "active" && capabilities.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Granted capabilities</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            <ul className="space-y-1.5 text-sm">
              {capabilities.map((cap) => {
                const granted = isCapabilityGranted(provider, cap, row.scopes);
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
              <p className="pt-1 text-[0.6875rem] leading-snug text-muted-foreground">
                Missing a capability? Click <strong>Reinstall</strong>{" "}
                {provider === "shopify"
                  ? "above — Shopify shows the merchant an “update permissions” prompt without losing the existing connection."
                  : "above to reconnect and grant the latest permissions."}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {showImapForm ? <ImapConnectForm /> : null}

      {isSheets ? <SheetTargetForm tone={tone} sheet={sheet} /> : null}
    </div>
  );
}
