"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { decideApprovalFromDashboard } from "@/lib/approvals";

// Server Actions. Submitted by the <form> elements in page.tsx.
//
// We use `formData` not a typed prop because Server Actions cross the
// network boundary; only serializable inputs survive. The approvalId
// is rendered as a hidden field by the page and read back here.
//
// Successful actions revalidate the approvals list (so the row drops
// off the "pending" view) and the case detail (so the timeline
// reflects the new state if/when the worker picks up the event).
// Then we redirect — `redirect()` throws, so anything below it is
// unreachable.

const approvalIdOf = (formData: FormData): string => {
  const id = formData.get("approvalId");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("approvalId missing from form data");
  }
  return id;
};

export const approveAction = async (formData: FormData): Promise<void> => {
  const approvalId = approvalIdOf(formData);
  const result = await decideApprovalFromDashboard(approvalId, "approve");
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalId}`);
  // Race: dashboard click + email link click can both decide the same
  // row. `result.kind` distinguishes — we let the list page render
  // the right "Approved ✓" / "Already decided" banner.
  redirect(`/approvals?decided=${approvalId}&action=approve&kind=${result.kind}`);
};

export const rejectAction = async (formData: FormData): Promise<void> => {
  const approvalId = approvalIdOf(formData);
  const result = await decideApprovalFromDashboard(approvalId, "reject");
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalId}`);
  redirect(`/approvals?decided=${approvalId}&action=reject&kind=${result.kind}`);
};
