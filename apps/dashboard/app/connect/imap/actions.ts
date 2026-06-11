"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

const str = (formData: FormData, key: string): string => {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const port = (formData: FormData, key: string, fallback: number): number => {
  const n = Number(str(formData, key));
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
};

/** useActionState shape for the IMAP connect form (U4). */
export interface ImapConnectState {
  readonly error:
    | "missing_fields"
    | "imap_connect_failed"
    | "imap_already_connected"
    | "legal_acceptance_required"
    | "unexpected";
  /** Connectivity-check detail from the api (host/auth error text). */
  readonly detail?: string;
  /** The already-connected mailbox, for the conflict message. */
  readonly mailbox?: string;
}

// useActionState (the onboarding/sign-up pattern, U4): a failed connectivity
// check returns state and React re-renders in place, so all eight fields —
// including the app password — survive instead of being wiped by a PRG
// redirect. Success still redirects to the integrations banner.
export const connectImapAction = async (
  _prev: ImapConnectState | null,
  formData: FormData,
): Promise<ImapConnectState | null> => {
  const ctx = await getDashboardContext();

  const mailbox = str(formData, "mailbox");
  const password = str(formData, "password");
  const imapHost = str(formData, "imapHost");
  const smtpHost = str(formData, "smtpHost");
  const user = str(formData, "user");

  if (!mailbox || !password || !imapHost || !smtpHost) {
    return { error: "missing_fields" };
  }

  const res = await api.connectImap(ctx, {
    mailbox,
    password,
    imapHost,
    imapPort: port(formData, "imapPort", 993),
    imapSecure: str(formData, "imapSecure") !== "false",
    smtpHost,
    smtpPort: port(formData, "smtpPort", 465),
    smtpSecure: str(formData, "smtpSecure") !== "false",
    ...(user ? { user } : {}),
  });

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
    };
  }
  if (res.status !== 200) {
    return { error: "unexpected" };
  }

  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?connected=imap");
};
