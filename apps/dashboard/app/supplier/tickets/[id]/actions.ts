"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api-client";
import { requireSupplierPermission } from "@/lib/require-supplier-permission";

export const postSupplierUpdateAction = async (
  formData: FormData,
): Promise<void> => {
  const id = formData.get("escalationId");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("escalationId missing from form data");
  }
  const note =
    typeof formData.get("note") === "string"
      ? (formData.get("note") as string)
      : "";
  const proposedRaw =
    typeof formData.get("proposedResolution") === "string"
      ? (formData.get("proposedResolution") as string)
      : "";

  const ctx = await requireSupplierPermission();
  const result = await api.supplierUpdate(ctx, id, {
    note,
    proposedResolution: proposedRaw.trim() ? proposedRaw : null,
  });

  revalidatePath("/supplier/tickets");
  revalidatePath(`/supplier/tickets/${id}`);
  redirect(
    `/supplier/tickets/${id}?updated=${result.status === 200 ? "ok" : String(result.status)}`,
  );
};
