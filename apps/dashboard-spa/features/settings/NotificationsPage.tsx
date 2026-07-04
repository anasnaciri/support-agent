import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, ExternalLink, Send } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { ApiConfigError } from "@/lib/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";

// Telegram merchant notifications. Port of apps/dashboard's
// /settings/notifications page + actions: read the current connection from
// `api.connections`, mint a signed t.me linking deep link with
// `api.connectTelegram`, and unlink with `api.disconnect(ctx, "telegram")`. The
// Next action surfaced errors via ?error= codes read by a FEEDBACK rule array;
// here the same copy is toasted directly from the mutation callbacks.

const ERROR_MESSAGES = {
  not_configured:
    "Telegram notifications aren't enabled on this deployment — ask your operator to configure the platform bot.",
  legal_acceptance_required:
    "Please accept the current terms under Settings → Legal before connecting a notification channel.",
  link_failed: "Couldn't generate a link right now. Please try again.",
} as const;

export function NotificationsPage() {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const allowed = useRequirePermission("settings.notifications");
  const [link, setLink] = useState<string | null>(null);

  const { data: connections, isLoading } = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
    enabled: allowed,
  });

  const generateM = useMutation({
    mutationFn: () => api.connectTelegram(ctx),
    onSuccess: (result) => {
      // on403:"return" hands the 403 body back rather than throwing — the api
      // gates the linking mint on current-terms acceptance.
      if (result.status === 403) {
        toast.warning(ERROR_MESSAGES.legal_acceptance_required);
        return;
      }
      const url =
        typeof result.body === "object" &&
        result.body !== null &&
        typeof (result.body as { url?: unknown }).url === "string"
          ? (result.body as { url: string }).url
          : null;
      if (result.status !== 200 || !url) {
        toast.warning(ERROR_MESSAGES.link_failed);
        return;
      }
      setLink(url);
    },
    onError: (error) => {
      // The api returns 503 when the platform bot isn't configured; the SPA
      // transport turns that into a thrown ApiConfigError.
      if (error instanceof ApiConfigError) {
        toast.warning(ERROR_MESSAGES.not_configured);
        return;
      }
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const disconnectM = useMutation({
    mutationFn: () => api.disconnect(ctx, "telegram"),
    onSuccess: () => {
      toast.success("Telegram disconnected.");
      setLink(null);
      void qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  if (!allowed) return null;

  const binding = (connections ?? []).find(
    (c) => c.provider === "telegram" && c.status === "active",
  );
  const metadata = (binding?.metadata ?? {}) as {
    username?: unknown;
    firstName?: unknown;
  };
  const chatLabel =
    typeof metadata.username === "string" && metadata.username
      ? `@${metadata.username}`
      : typeof metadata.firstName === "string" && metadata.firstName
        ? metadata.firstName
        : binding?.shopDomain
          ? `chat ${binding.shopDomain}`
          : null;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Notifications" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Get a Telegram message the moment your agent needs you — a reply
          waiting for approval, a ticket it couldn&apos;t finish, a broken
          connection, or your AI credits running low.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="size-4" aria-hidden />
            Telegram
            {binding ? <Badge variant="success">Connected</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : binding ? (
            <>
              <p className="text-sm text-muted-foreground">
                Notifications are going to{" "}
                <span className="font-medium text-foreground">
                  {chatLabel ?? "your linked chat"}
                </span>
                . Re-linking from another chat moves notifications there.
              </p>
              <ConfirmButton
                variant="outline"
                title="Disconnect Telegram?"
                description="Your agent will stop sending notifications to this chat. You can reconnect any time."
                confirmLabel="Disconnect"
                pending={disconnectM.isPending}
                onConfirm={() => disconnectM.mutate()}
              >
                Disconnect
              </ConfirmButton>
            </>
          ) : link ? (
            <>
              <p className="text-sm text-muted-foreground">
                Open the link below and press <strong>Start</strong> in
                Telegram. The link expires after 15 minutes — then come back
                and refresh this page.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button asChild>
                  <a href={link} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="size-4" aria-hidden />
                    Open Telegram
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={generateM.isPending}
                  onClick={() => generateM.mutate()}
                >
                  Generate a new link
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Connect your personal or team Telegram chat. You&apos;ll get a
                short-lived link that opens our bot — press{" "}
                <strong>Start</strong> there and you&apos;re done.
              </p>
              <Button
                type="button"
                disabled={generateM.isPending}
                onClick={() => generateM.mutate()}
              >
                <Bell className="size-4" aria-hidden />
                Connect Telegram
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What gets sent</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Replies and refunds waiting for your approval, with one-tap approve/reject links.</li>
            <li>Tickets the agent couldn&apos;t finish and handed to you.</li>
            <li>Heads-ups the agent sends when it&apos;s unsure about something.</li>
            <li>A mailbox or store connection that stopped working.</li>
            <li>Your AI provider credits running low.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
