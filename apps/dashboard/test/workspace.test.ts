import { describe, expect, it } from "vitest";
import { pickActiveWorkspace } from "../lib/workspace";
import type { WorkspaceSummary } from "@support-agent/dashboard-contracts";

const ws = (id: string, name: string): WorkspaceSummary => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  shopifyDomain: null,
});

// The workspace cookie is advisory: RSCs can't rewrite it, so a stale value
// (deleted workspace, copied cookie from another org) must silently resolve
// to the org's default workspace — the API list (default first) is truth.
describe("pickActiveWorkspace", () => {
  const list = [ws("a", "Default"), ws("b", "Second"), ws("c", "Third")];

  it("picks the cookie's workspace when it is in the org's list", () => {
    expect(pickActiveWorkspace(list, "b")?.id).toBe("b");
  });

  it("falls back to the default (first) workspace for a stale cookie", () => {
    expect(pickActiveWorkspace(list, "deleted-ws")?.id).toBe("a");
  });

  it("falls back to the default when there is no cookie", () => {
    expect(pickActiveWorkspace(list, undefined)?.id).toBe("a");
    expect(pickActiveWorkspace(list, "")?.id).toBe("a");
  });

  it("returns null for an empty list (org needs onboarding)", () => {
    expect(pickActiveWorkspace([], "a")).toBeNull();
    expect(pickActiveWorkspace([], undefined)).toBeNull();
  });
});
