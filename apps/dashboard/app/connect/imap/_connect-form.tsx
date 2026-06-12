"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SubmitButton } from "@/components/ui/submit-button";

import { connectImapAction, type ImapConnectState } from "./actions";

const OAUTH_LABEL = { google: "Google", outlook: "Microsoft" } as const;

// Default view: email + app password only — server settings come from the
// api's autodiscovery. The Advanced <details> opens itself (and is prefilled
// with whatever discovery found) only when the merchant actually has to look
// at it: detection failed, a half-filled section, or a failed login.
// useActionState keeps every field — including the app password — across a
// failed 10–30s connectivity check (U4), and the submit button shows a
// pending state for the whole find-and-verify round trip (U3).
export const ImapConnectForm = () => {
  const [state, formAction, pending] = useActionState(
    connectImapAction,
    null as ImapConnectState | null,
  );
  const [advancedToggled, setAdvancedToggled] = useState(false);

  const discovered =
    state?.error === "imap_connect_failed" ? state.discovered : undefined;
  const needsAdvanced =
    state?.error === "needs_server_settings" ||
    state?.error === "missing_hosts" ||
    discovered !== undefined;
  const prefill = discovered?.settings;

  return (
    <form action={formAction} className="space-y-5">
      {state?.error === "missing_fields" ? (
        <Alert variant="warning">
          <AlertDescription>
            Email address and app password are required.
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
      {state?.error === "imap_connect_failed" ? (
        <Alert variant="warning">
          <AlertTitle>Couldn&apos;t sign in</AlertTitle>
          <AlertDescription>
            {discovered ? (
              <>
                We found the server settings
                {discovered.providerName ? (
                  <> for <strong>{discovered.providerName}</strong></>
                ) : null}{" "}
                but signing in failed — double-check the app password.{" "}
                {discovered.appPasswordUrl ? (
                  <a
                    href={discovered.appPasswordUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    Create an app password
                  </a>
                ) : null}
              </>
            ) : (
              <>
                We couldn&apos;t sign in with those details. Check the server
                settings and app password.
              </>
            )}
            {state.detail ? (
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
        <p className="text-xs text-muted-foreground">
          An app password from your email provider — usually created under
          security settings. Not your normal sign-in password.
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
        {/* Remount when discovery hands back a prefill, so defaultValue
            applies to fields the merchant left empty. */}
        <div
          key={prefill ? `${prefill.imapHost}|${prefill.smtpHost}` : "manual"}
          className="space-y-4 border-t p-4"
        >
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
              defaultValue={prefill?.username ?? ""}
              disabled={pending}
            />
          </div>

          <fieldset className="grid gap-3 rounded-md border p-4" disabled={pending}>
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
                  defaultValue={prefill?.imapHost ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="imapPort">Port</Label>
                <Input
                  id="imapPort"
                  name="imapPort"
                  type="number"
                  defaultValue={prefill?.imapPort ?? 993}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="imapSecure">Security</Label>
              <NativeSelect
                id="imapSecure"
                name="imapSecure"
                defaultValue={prefill ? String(prefill.imapSecure) : "true"}
              >
                <option value="true">TLS / SSL (port 993)</option>
                <option value="false">STARTTLS (port 143)</option>
              </NativeSelect>
            </div>
          </fieldset>

          <fieldset className="grid gap-3 rounded-md border p-4" disabled={pending}>
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
                  defaultValue={prefill?.smtpHost ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="smtpPort">Port</Label>
                <Input
                  id="smtpPort"
                  name="smtpPort"
                  type="number"
                  defaultValue={prefill?.smtpPort ?? 465}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="smtpSecure">Security</Label>
              <NativeSelect
                id="smtpSecure"
                name="smtpSecure"
                defaultValue={prefill ? String(prefill.smtpSecure) : "true"}
              >
                <option value="true">TLS / SSL (port 465)</option>
                <option value="false">STARTTLS (port 587)</option>
              </NativeSelect>
            </div>
          </fieldset>
        </div>
      </details>

      <SubmitButton pendingLabel="Finding your provider & verifying…">
        Connect mailbox
      </SubmitButton>
    </form>
  );
};
