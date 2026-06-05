"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { adminApi } from "@/lib/admin-api";
import { requireSession } from "@/lib/session";

export async function provisionShopifyAppAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireSession();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "");
  if (!clientId || !clientSecret) {
    redirect(`/tenants/${id}?error=missing_fields`);
  }
  const res = await adminApi.putShopifyApp(id, clientId, clientSecret);
  if (res.status === 404) redirect(`/tenants/${id}?error=tenant_not_found`);
  if (!res.ok) redirect(`/tenants/${id}?error=provision_failed`);
  revalidatePath(`/tenants/${id}`);
  redirect(`/tenants/${id}?ok=shopify_saved`);
}

export async function revokeShopifyAppAction(id: string): Promise<void> {
  await requireSession();
  const res = await adminApi.revokeShopifyApp(id);
  if (!res.ok) redirect(`/tenants/${id}?error=revoke_failed`);
  revalidatePath(`/tenants/${id}`);
  redirect(`/tenants/${id}?ok=shopify_revoked`);
}

export async function deleteTenantAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireSession();
  const confirm = String(formData.get("confirmName") ?? "");
  const detail = await adminApi.tenantDetail(id);
  if (!detail) redirect("/");
  if (confirm !== detail.tenant.name) {
    redirect(`/tenants/${id}?error=name_mismatch`);
  }
  const res = await adminApi.deleteTenant(id);
  if (!res.ok) redirect(`/tenants/${id}?error=delete_failed`);
  revalidatePath("/");
  redirect("/?ok=tenant_deleted");
}
