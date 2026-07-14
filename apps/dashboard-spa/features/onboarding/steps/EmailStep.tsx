import { Check, Loader2, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/components/ui/link";
import { hasMailbox } from "@/lib/setup-readiness";
import type { WizardStepProps } from "../steps";
import { activeConnection, useConnections, useWizardConnect } from "../use-connect";

// Step 8. Where the tickets come from. Skippable, because the mailbox is often
// owned by someone else at the company and the merchant may need to go and ask
// — but nothing arrives until this is done, and the SetupWarnings banner keeps
// saying so.
//
// Gmail and Outlook are OAuth round-trips out of the SPA; IMAP needs a form
// (host, port, credentials) that belongs on its own page rather than inline in a
// wizard step.

const OAUTH_PROVIDERS = [
  {
    id: "gmail",
    label: "Gmail",
    detail: "Google Workspace or a personal Gmail account.",
  },
  {
    id: "outlook",
    label: "Outlook",
    detail: "Microsoft 365 or Outlook.com.",
  },
] as const;

export function EmailStep({ onDone, canEdit }: WizardStepProps) {
  const connections = useConnections();
  const connect = useWizardConnect("email");

  if (connections.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const connected = hasMailbox(connections.data ?? []);
  if (connected) {
    const gmail = activeConnection(connections.data, "gmail");
    const outlook = activeConnection(connections.data, "outlook");
    const imap = activeConnection(connections.data, "imap");
    const which = gmail ? "Gmail" : outlook ? "Outlook" : imap ? "IMAP" : "Inbox";
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-3 py-4">
            <Check className="size-4 shrink-0 text-success" />
            <div>
              <p className="text-sm font-medium">{which} connected</p>
              <p className="text-sm text-muted-foreground">
                New customer emails will open tickets here.
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
      <div className="grid gap-3 sm:grid-cols-2">
        {OAUTH_PROVIDERS.map((p) => (
          <Card key={p.id}>
            <CardContent className="flex flex-col items-start gap-3 py-5">
              <div className="flex items-center gap-2">
                <Mail className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{p.label}</span>
                {p.id === "outlook" && <Badge variant="secondary">Beta</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">{p.detail}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => connect.mutate(p.id)}
                disabled={!canEdit || connect.isPending}
              >
                {connect.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Connect {p.label}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Using something else? Any IMAP mailbox works —{" "}
        <Link
          href="/settings/integrations/imap"
          className="font-medium underline underline-offset-4"
        >
          connect it with a host and password
        </Link>
        .
      </p>
    </div>
  );
}
