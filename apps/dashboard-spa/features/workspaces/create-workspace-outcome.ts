import type { CreateWorkspaceResult } from "@support-agent/dashboard-contracts";

// Pure routing for the new-workspace form's submit result (port of the Next
// createWorkspaceAction): the api copies the org's current legal acceptance
// onto the new workspace, so a stale acceptance routes to the legal page
// instead of failing opaquely.

export interface CreateWorkspaceResponse {
  readonly status: number;
  readonly result: CreateWorkspaceResult | null;
  readonly error: string | null;
}

export type CreateWorkspaceOutcome =
  | {
      readonly kind: "created";
      readonly workspaceId: string;
      readonly redirectTo: string;
    }
  | { readonly kind: "legal_required"; readonly redirectTo: string }
  | { readonly kind: "error"; readonly message: string };

export const createWorkspaceOutcome = (
  res: CreateWorkspaceResponse,
): CreateWorkspaceOutcome => {
  if (res.error === "legal_acceptance_required") {
    return { kind: "legal_required", redirectTo: "/settings/legal" };
  }
  if (!res.result) {
    return {
      kind: "error",
      message: "Could not create the workspace. Please try again.",
    };
  }
  return {
    kind: "created",
    workspaceId: res.result.workspaceId,
    redirectTo: "/?workspace_created=1",
  };
};
