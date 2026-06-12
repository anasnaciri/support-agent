"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";
import {
  planImapConnect,
  type DiscoveredPrefill,
  type ImapDiscoveryResponse,
  type ImapFormValues,
} from "./connect-plan";

const str = (formData: FormData, key: string): string => {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
};

/** useActionState shape for the IMAP connect form (U4). */
export interface ImapConnectState {
  readonly error:
    | "missing_fields"
    | "missing_hosts"
    | "needs_server_settings"
    | "use_oauth_connector"
    | "imap_connect_failed"
    | "imap_already_connected"
    | "legal_acceptance_required"
    | "unexpected";
  /** Connectivity-check detail from the api (host/auth error text). */
  readonly detail?: string;
  /** The already-connected mailbox, for the conflict message. */
  readonly mailbox?: string;
  /** Which OAuth connector to use instead (use_oauth_connector). */
  readonly provider?: "google" | "outlook";
  /** Discovery behind a failed login — opens + prefills the Advanced
   * section and carries provider name / app-password help. */
  readonly discovered?: DiscoveredPrefill;
}

// useActionState (the onboarding/sign-up pattern, U4): a failed connectivity
// check returns state and React re-renders in place, so every field —
// including the app password — survives instead of being wiped by a PRG
// redirect. Success still redirects to the integrations banner.
//
// By default only email + app password are submitted; server settings come
// from the api's autodiscovery (`planImapConnect` decides). The Advanced
// section, when filled, bypasses discovery entirely.
export const connectImapAction = async (
  _prev: ImapConnectState | null,
  formData: FormData,
): Promise<ImapConnectState | null> => {
  const ctx = await getDashboardContext();

  const values: ImapFormValues = {
    mailbox: str(formData, "mailbox"),
    password: str(formData, "password"),
    user: str(formData, "user"),
    imapHost: str(formData, "imapHost"),
    imapPort: str(formData, "imapPort"),
    imapSecure: str(formData, "imapSecure"),
    smtpHost: str(formData, "smtpHost"),
    smtpPort: str(formData, "smtpPort"),
    smtpSecure: str(formData, "smtpSecure"),
  };

  const plan = await planImapConnect(values, async (email) => {
    const res = await api.discoverImap(ctx, { email });
    return res.status === 200 ? (res.body as ImapDiscoveryResponse) : null;
  });

  if (plan.action === "error") return { error: plan.error };
  if (plan.action === "oauth") {
    return { error: "use_oauth_connector", provider: plan.provider };
  }
  if (plan.action === "needs_settings") {
    return { error: "needs_server_settings" };
  }

  const res = await api.connectImap(ctx, plan.input);

  if (res.status === 403) {
    return { error: "legal_acceptance_required" };
  }
  if (res.status === 409) {
    const body = res.body as { mailbox?: string } | null;
    return {
      error: "imap_already_connected",
      ...(body?.mailbox ? { mailbox: body.mailbox } : {}),
    };
  }
  if (res.status === 400) {
    const body = res.body as { detail?: string } | null;
    return {
      error: "imap_connect_failed",
      ...(body?.detail ? { detail: body.detail } : {}),
      ...(plan.discovered ? { discovered: plan.discovered } : {}),
    };
  }
  if (res.status !== 200) {
    return { error: "unexpected" };
  }

  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?connected=imap");
};
