import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2, Send } from "lucide-react";

import { api } from "@/lib/api-client";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { WizardStepProps } from "../steps";
import { activeConnection, useConnections } from "../use-connect";

// Step 9. Where approvals reach the merchant.
//
// This is the step that decides whether the approval loop actually closes: a
// refund queued for approval that nobody sees is a customer waiting for days.
// Email works, but a merchant is far more likely to answer a phone push.
//
// The link is a signed t.me deep link with a 15-minute TTL, minted server-side.

export function TelegramStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const connections = useConnections();
  const [link, setLink] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: () => api.connectTelegram(ctx),
    onSuccess: (result) => {
      const url =
        typeof result.body === "object" &&
        result.body !== null &&
        typeof (result.body as { url?: unknown }).url === "string"
          ? (result.body as { url: string }).url
          : null;
      if (result.status !== 200 || !url) {
        toast.warning("Couldn't generate a link right now. Please try again.");
        return;
      }
      setLink(url);
    },
    onError: () => toast.warning("Couldn't generate a link. Please try again."),
  });

  if (connections.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const connected = Boolean(activeConnection(connections.data, "telegram"));
  if (connected) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Check className="size-4 shrink-0 text-success" />
            <div>
              <p className="text-sm font-medium">Telegram connected</p>
              <p className="text-sm text-muted-foreground">
                Approvals will reach you on your phone.
              </p>
            </div>
          </CardContent>
        </Card>
        <Button onClick={onDone}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Telegram</span>
          </div>
          <p className="text-sm text-muted-foreground">
            When the agent needs your approval — a refund, a cancellation — it
            will message you here. Approve or reject from your phone and the agent
            carries on.
          </p>
          {link ? (
            <div className="space-y-2">
              <Button asChild size="sm">
                <a href={link} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Open Telegram
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                This link is valid for 15 minutes. Once you've hit Start in
                Telegram, come back here and continue.
              </p>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => generate.mutate()}
              disabled={!canEdit || generate.isPending}
            >
              {generate.isPending && <Loader2 className="size-4 animate-spin" />}
              Get my Telegram link
            </Button>
          )}
        </CardContent>
      </Card>

      {link && (
        <Button
          onClick={() => {
            void connections.refetch();
            onDone();
          }}
        >
          I've connected it, continue
        </Button>
      )}
    </div>
  );
}
