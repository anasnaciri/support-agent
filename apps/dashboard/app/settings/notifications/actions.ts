"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

/**
 * Mint a fresh Telegram linking deep link and surface it back on the
 * page via `?link=` (the link is signed + short-lived, not a secret the
 * URL bar can leak anything durable from).
 */
export const generateTelegramLinkAction = async (): Promise<void> => {
  const ctx = await getDashboardContext();
  const result = await api.connectTelegram(ctx);
  if (result.status === 503) {
    redirect("/settings/notifications?error=not_configured");
  }
  if (result.status === 403) {
    redirect("/settings/notifications?error=legal_acceptance_required");
  }
  const url =
    typeof result.body === "object" &&
    result.body !== null &&
    typeof (result.body as { url?: unknown }).url === "string"
      ? (result.body as { url: string }).url
      : null;
  if (result.status !== 200 || !url) {
    redirect("/settings/notifications?error=link_failed");
  }
  redirect(`/settings/notifications?link=${encodeURIComponent(url)}`);
};

export const disconnectTelegramAction = async (): Promise<void> => {
  const ctx = await getDashboardContext();
  await api.disconnect(ctx, "telegram");
  revalidatePath("/settings/notifications");
  redirect("/settings/notifications?disconnected=1");
};
