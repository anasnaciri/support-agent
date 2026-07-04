import { describe, expect, it } from "vitest";

import { createWorkspaceOutcome } from "../features/workspaces/create-workspace-outcome";

// Mirrors the Next app's createWorkspaceAction routing: a stale legal
// acceptance routes to the legal page instead of failing opaquely, success
// switches into the new workspace and lands home with the created toast.
describe("createWorkspaceOutcome", () => {
  it("routes a stale legal acceptance to the legal page", () => {
    expect(
      createWorkspaceOutcome({
        status: 403,
        result: null,
        error: "legal_acceptance_required",
      }),
    ).toEqual({ kind: "legal_required", redirectTo: "/settings/legal" });
  });

  it("lands home with the workspace-created toast on success", () => {
    expect(
      createWorkspaceOutcome({
        status: 200,
        result: { workspaceId: "ws-2" },
        error: null,
      }),
    ).toEqual({
      kind: "created",
      workspaceId: "ws-2",
      redirectTo: "/?workspace_created=1",
    });
  });

  it("surfaces any other failure as a retryable form error", () => {
    expect(
      createWorkspaceOutcome({ status: 500, result: null, error: "unknown" }),
    ).toEqual({
      kind: "error",
      message: "Could not create the workspace. Please try again.",
    });
  });
});
