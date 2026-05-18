"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { takeOverCase } from "@/lib/case-actions";
import { getTenantId } from "@/lib/tenant";

const caseIdOf = (formData: FormData): string => {
  const id = formData.get("caseId");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("caseId missing from form data");
  }
  return id;
};

export const takeOverAction = async (formData: FormData): Promise<void> => {
  const caseId = caseIdOf(formData);
  const tenantId = await getTenantId();
  const { user } = await withAuth();
  if (!user) throw new Error("unauthenticated");

  const result = await takeOverCase({
    caseId,
    tenantId,
    managerId: user.id,
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/approvals");
  redirect(`/cases/${caseId}?takenOver=${result.kind}`);
};
