"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { api, getDashboardContext } from "@/lib/api-client";

export const acceptLegalAction = async (): Promise<void> => {
  const ctx = await getDashboardContext();
  const res = await api.acceptLegal(ctx);
  if (res.status !== 200) {
    redirect("/settings/legal?error=accept_failed");
  }
  revalidatePath("/settings");
  revalidatePath("/settings/legal");
  revalidatePath("/settings/integrations");
  revalidatePath("/settings/llm");
  redirect("/settings/legal?accepted=1");
};
