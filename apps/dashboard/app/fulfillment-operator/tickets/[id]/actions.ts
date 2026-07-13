"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api-client";
import { requireFulfillmentOperatorPermission } from "@/lib/require-fulfillment-operator-permission";

export const postFulfillmentOperatorUpdateAction = async (
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

  const ctx = await requireFulfillmentOperatorPermission();
  const result = await api.fulfillmentOperatorUpdate(ctx, id, {
    note,
    proposedResolution: proposedRaw.trim() ? proposedRaw : null,
  });

  revalidatePath("/fulfillment-operator/tickets");
  revalidatePath(`/fulfillment-operator/tickets/${id}`);
  redirect(
    `/fulfillment-operator/tickets/${id}?updated=${result.status === 200 ? "ok" : String(result.status)}`,
  );
};
