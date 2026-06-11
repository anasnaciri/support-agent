"use client";

import { useActionState } from "react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SubmitButton } from "@/components/ui/submit-button";

import { connectImapAction, type ImapConnectState } from "./actions";

// useActionState keeps every field — including the app password — when the
// 10–30s connectivity check fails (U4), and the submit button shows a
// pending state for the whole check (U3).
export const ImapConnectForm = () => {
  const [state, formAction, pending] = useActionState(
    connectImapAction,
    null as ImapConnectState | null,
  );

  return (
    <form action={formAction} className="space-y-5">
      {state?.error === "missing_fields" ? (
        <Alert variant="warning">
          <AlertDescription>
            Mailbox, password, and both server hosts are required.
          </AlertDescription>
        </Alert>
      ) : null}
      {state?.error === "imap_connect_failed" ? (
        <Alert variant="warning">
          <AlertTitle>Couldn&apos;t connect</AlertTitle>
          <AlertDescription>
            We couldn&apos;t log in to IMAP or SMTP with those details. Check the
            host, port, and app password.
            {state.detail ? (
              <span className="mt-1 block font-mono text-xs opacity-80">
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
        />
        <p className="text-xs text-muted-foreground">
          The address customers email. Replies are sent from here.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="password">App password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="off"
          required
          disabled={pending}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="user">
          Login username{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="user"
          name="user"
          autoComplete="off"
          placeholder="Defaults to the email address"
          disabled={pending}
        />
      </div>

      <fieldset className="grid gap-3 rounded-md border p-4" disabled={pending}>
        <legend className="px-1 text-sm font-medium">Incoming (IMAP)</legend>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <div className="grid gap-2">
            <Label htmlFor="imapHost">Host</Label>
            <Input
              id="imapHost"
              name="imapHost"
              placeholder="imap.yourprovider.com"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="imapPort">Port</Label>
            <Input id="imapPort" name="imapPort" type="number" defaultValue={993} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="imapSecure">Security</Label>
          <NativeSelect id="imapSecure" name="imapSecure" defaultValue="true">
            <option value="true">TLS / SSL (port 993)</option>
            <option value="false">None / STARTTLS (port 143)</option>
          </NativeSelect>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border p-4" disabled={pending}>
        <legend className="px-1 text-sm font-medium">Outgoing (SMTP)</legend>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <div className="grid gap-2">
            <Label htmlFor="smtpHost">Host</Label>
            <Input
              id="smtpHost"
              name="smtpHost"
              placeholder="smtp.yourprovider.com"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="smtpPort">Port</Label>
            <Input id="smtpPort" name="smtpPort" type="number" defaultValue={465} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="smtpSecure">Security</Label>
          <NativeSelect id="smtpSecure" name="smtpSecure" defaultValue="true">
            <option value="true">TLS / SSL (port 465)</option>
            <option value="false">STARTTLS / none (port 587)</option>
          </NativeSelect>
        </div>
      </fieldset>

      <SubmitButton pendingLabel="Verifying both servers…">
        Verify &amp; connect
      </SubmitButton>
    </form>
  );
};
