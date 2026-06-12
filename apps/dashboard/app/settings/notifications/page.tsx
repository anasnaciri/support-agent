import { Bell, ExternalLink, Send } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import {
  disconnectTelegramAction,
  generateTelegramLinkAction,
} from "./actions";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_configured:
    "Telegram notifications aren't enabled on this deployment — ask your operator to configure the platform bot.",
  legal_acceptance_required:
    "Please accept the current terms under Settings → Legal before connecting a notification channel.",
  link_failed: "Couldn't generate a link right now. Please try again.",
};

export default async function NotificationsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const connections = await api.connections(ctx);
  const params = (await searchParams) ?? {};

  const binding = connections.find(
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

  const link = one(params["link"]);
  const disconnected = one(params["disconnected"]) === "1";
  const errorCode = one(params["error"]);

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Notifications" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Get a Telegram message the moment your agent needs you — a reply
          waiting for approval, a case it couldn&apos;t finish, a broken
          connection, or your AI credits running low.
        </p>
      </div>

      {disconnected ? (
        <Alert variant="success">
          <AlertDescription>Telegram disconnected.</AlertDescription>
        </Alert>
      ) : null}
      {errorCode ? (
        <Alert variant="warning">
          <AlertDescription>
            {ERROR_MESSAGES[errorCode] ?? "Something went wrong. Please try again."}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Send className="size-4" aria-hidden />
            Telegram
            {binding ? <Badge variant="success">Connected</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {binding ? (
            <>
              <p className="text-sm text-muted-foreground">
                Notifications are going to{" "}
                <span className="font-medium text-foreground">
                  {chatLabel ?? "your linked chat"}
                </span>
                . Re-linking from another chat moves notifications there.
              </p>
              <form action={disconnectTelegramAction}>
                <ConfirmSubmitButton
                  variant="outline"
                  title="Disconnect Telegram?"
                  description="Your agent will stop sending notifications to this chat. You can reconnect any time."
                  confirmLabel="Disconnect"
                >
                  Disconnect
                </ConfirmSubmitButton>
              </form>
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
                <form action={generateTelegramLinkAction}>
                  <Button type="submit" variant="ghost">
                    Generate a new link
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Connect your personal or team Telegram chat. You&apos;ll get a
                short-lived link that opens our bot — press{" "}
                <strong>Start</strong> there and you&apos;re done.
              </p>
              <form action={generateTelegramLinkAction}>
                <Button type="submit">
                  <Bell className="size-4" aria-hidden />
                  Connect Telegram
                </Button>
              </form>
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
            <li>Cases the agent couldn&apos;t finish and handed to you.</li>
            <li>Heads-ups the agent sends when it&apos;s unsure about something.</li>
            <li>A mailbox or store connection that stopped working.</li>
            <li>Your AI provider credits running low.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
