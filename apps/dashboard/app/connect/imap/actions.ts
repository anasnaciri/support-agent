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

export const connectImapAction = async (formData: FormData): Promise<void> => {
  const ctx = await getDashboardContext();

  const mailbox = str(formData, "mailbox");
  const password = str(formData, "password");
  const imapHost = str(formData, "imapHost");
  const smtpHost = str(formData, "smtpHost");
  const user = str(formData, "user");

  if (!mailbox || !password || !imapHost || !smtpHost) {
    redirect("/connect/imap?error=missing_fields");
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
    redirect("/connect/imap?error=legal_acceptance_required");
  }
  if (res.status === 409) {
    const body = res.body as { mailbox?: string } | null;
    const mb = body?.mailbox
      ? `&mailbox=${encodeURIComponent(body.mailbox)}`
      : "";
    redirect(`/connect/imap?error=imap_already_connected${mb}`);
  }
  if (res.status === 400) {
    const body = res.body as { error?: string; detail?: string } | null;
    const err = body?.error ?? "imap_connect_failed";
    const detail = body?.detail ? `&detail=${encodeURIComponent(body.detail)}` : "";
    redirect(`/connect/imap?error=${encodeURIComponent(err)}${detail}`);
  }
  if (res.status !== 200) {
    redirect("/connect/imap?error=unexpected");
  }

  revalidatePath("/settings/integrations");
  redirect("/settings/integrations?connected=imap");
};
