"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

// All disconnects redirect with one generic `?disconnected=<provider>` param
// (U5) — the page renders a single success banner from it, so every provider
// (incl. outlook/imap, which used to fall through) gets feedback.
const disconnectProvider = async (
  provider: "shopify" | "gmail" | "google_sheets" | "outlook" | "imap",
): Promise<void> => {
  const ctx = await getDashboardContext();
  await api.disconnect(ctx, provider);
  revalidatePath("/settings/integrations");
  redirect(
    `/settings/integrations?disconnected=${encodeURIComponent(provider)}`,
  );
};

export const disconnectShopifyAction = async (): Promise<void> =>
  disconnectProvider("shopify");

export const disconnectGmailAction = async (): Promise<void> =>
  disconnectProvider("gmail");

export const disconnectGoogleSheetsAction = async (): Promise<void> =>
  disconnectProvider("google_sheets");

export const disconnectOutlookAction = async (): Promise<void> =>
  disconnectProvider("outlook");

export const disconnectImapAction = async (): Promise<void> =>
  disconnectProvider("imap");
