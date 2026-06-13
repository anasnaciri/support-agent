"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { adminApi } from "@/lib/admin-api";
import { requireSession } from "@/lib/session";

export async function setAccountOpenRouterAction(
  organizationId: string,
  formData: FormData,
): Promise<void> {
  await requireSession();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (apiKey.length < 8) {
    redirect(`/accounts/${organizationId}?error=missing_key`);
  }
  const res = await adminApi.putAccountOpenRouter(organizationId, apiKey);
  if (res.status === 403) {
    redirect(`/accounts/${organizationId}?error=legal_acceptance_required`);
  }
  if (!res.ok) redirect(`/accounts/${organizationId}?error=save_failed`);
  revalidatePath(`/accounts/${organizationId}`);
  redirect(`/accounts/${organizationId}?ok=openrouter_saved`);
}

export async function revokeAccountOpenRouterAction(
  organizationId: string,
): Promise<void> {
  await requireSession();
  const res = await adminApi.revokeAccountOpenRouter(organizationId);
  if (!res.ok) redirect(`/accounts/${organizationId}?error=revoke_failed`);
  revalidatePath(`/accounts/${organizationId}`);
  redirect(`/accounts/${organizationId}?ok=openrouter_revoked`);
}
