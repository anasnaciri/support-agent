"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { approvals } from "@support-agent/db";
import { db } from "@/lib/db";
import { getTenantId } from "@/lib/tenant";
import { decideApprovalFromDashboard } from "@/lib/approvals";

// Pull the proposedInput for an approval the manager is about to
// approve-with-edits. Tenant-scoped read so a server action can't
// cross-leak inputs between tenants. Returns null on miss — the
// action then falls back to a no-edit approve.
const loadProposedInput = async (
  approvalId: string,
): Promise<unknown | null> => {
  const tenantId = await getTenantId();
  const [row] = await db()
    .select({ proposedInput: approvals.proposedInput })
    .from(approvals)
    .where(
      and(eq(approvals.id, approvalId), eq(approvals.tenantId, tenantId)),
    )
    .limit(1);
  return row?.proposedInput ?? null;
};

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

// Optional `returnTo` form field lets a caller redirect back to a
// page other than /approvals after the decision — e.g. the inline
// approval card on the case detail page wants to stay on the case.
// We only honor in-app absolute paths (starting with "/") to avoid
// turning this into an open redirect.
const returnToOf = (formData: FormData): string | null => {
  const raw = formData.get("returnTo");
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  return raw;
};

const banneredPath = (
  basePath: string,
  approvalId: string,
  action: "approve" | "reject",
  kind: string,
): string =>
  `${basePath}${basePath.includes("?") ? "&" : "?"}decided=${approvalId}&action=${action}&kind=${kind}`;

export const approveAction = async (formData: FormData): Promise<void> => {
  const approvalId = approvalIdOf(formData);

  // Edit-and-Approve: when the form posts a `bodyText` field (the
  // textarea on the approval detail page for conversation.reply
  // approvals), we treat it as a manager-edited override. We hydrate
  // the rest of the proposed input from the DB so the override stays
  // shape-compatible with what the gated tool expects.
  //
  // For non-conversation.reply approvals — or when bodyText is absent
  // from the form — we pass no approvedInput, which falls back to the
  // original proposedInput at runtime resume time.
  const bodyTextRaw = formData.get("bodyText");
  let approvedInput: unknown = undefined;
  if (typeof bodyTextRaw === "string") {
    const original = await loadProposedInput(approvalId);
    if (
      original &&
      typeof original === "object" &&
      "bodyText" in original
    ) {
      approvedInput = { ...original, bodyText: bodyTextRaw };
    }
  }

  const result = await decideApprovalFromDashboard(
    approvalId,
    "approve",
    approvedInput !== undefined ? { approvedInput } : {},
  );
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalId}`);
  const returnTo = returnToOf(formData);
  if (returnTo) revalidatePath(returnTo);
  // Race: dashboard click + email link click can both decide the same
  // row. `result.kind` distinguishes — we let the list page render
  // the right "Approved ✓" / "Already decided" banner.
  redirect(
    banneredPath(returnTo ?? "/approvals", approvalId, "approve", result.kind),
  );
};

export const rejectAction = async (formData: FormData): Promise<void> => {
  const approvalId = approvalIdOf(formData);
  const result = await decideApprovalFromDashboard(approvalId, "reject");
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${approvalId}`);
  const returnTo = returnToOf(formData);
  if (returnTo) revalidatePath(returnTo);
  redirect(
    banneredPath(returnTo ?? "/approvals", approvalId, "reject", result.kind),
  );
};
