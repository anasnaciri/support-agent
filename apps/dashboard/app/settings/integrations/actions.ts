"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

const disconnectProvider = async (
  provider: "shopify" | "gmail" | "google_sheets" | "outlook" | "imap",
): Promise<void> => {
  const ctx = await getDashboardContext();
  await api.disconnect(ctx, provider);
  revalidatePath("/settings/integrations");
};

export const disconnectShopifyAction = async (): Promise<void> => {
  await disconnectProvider("shopify");
  redirect("/settings/integrations?shopify=disconnected");
};

export const disconnectGmailAction = async (): Promise<void> => {
  await disconnectProvider("gmail");
  redirect("/settings/integrations?gmail=disconnected");
};

export const disconnectGoogleSheetsAction = async (): Promise<void> => {
  await disconnectProvider("google_sheets");
  redirect("/settings/integrations?sheets=disconnected");
};

export const disconnectOutlookAction = async (): Promise<void> => {
  await disconnectProvider("outlook");
  redirect("/settings/integrations?outlook=disconnected");
};

export const disconnectImapAction = async (): Promise<void> => {
  await disconnectProvider("imap");
  redirect("/settings/integrations?imap=disconnected");
};
