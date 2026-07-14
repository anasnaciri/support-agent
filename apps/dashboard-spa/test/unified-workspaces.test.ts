import { describe, expect, it } from "vitest";
import {
  mergeWorkspaces,
  surfaceHomeForKind,
  type WorkspaceSummary,
} from "@support-agent/dashboard-contracts";

const ws = (id: string, name: string): WorkspaceSummary => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  shopifyDomain: null,
  onboardingPending: false,
});

describe("mergeWorkspaces", () => {
  const merchant = [ws("m1", "My Store"), ws("m2", "Second Store")];
  const fulfillmentOperator = [ws("s1", "Vendor A"), ws("s2", "Vendor B")];

  it("tags merchant + fulfillment partner entries and lists merchant first", () => {
    const merged = mergeWorkspaces(merchant, fulfillmentOperator, true);
    expect(merged.map((w) => [w.id, w.kind])).toEqual([
      ["m1", "merchant"],
      ["m2", "merchant"],
      ["s1", "fulfillment_operator"],
      ["s2", "fulfillment_operator"],
    ]);
  });

  it("drops the merchant portion for a pure fulfillment partner (includeMerchant=false)", () => {
    const merged = mergeWorkspaces(merchant, fulfillmentOperator, false);
    expect(merged.map((w) => w.id)).toEqual(["s1", "s2"]);
    expect(merged.every((w) => w.kind === "fulfillment_operator")).toBe(true);
  });

  it("dedupes a workspace present in both lists — merchant wins", () => {
    const merged = mergeWorkspaces([ws("x", "Store X")], [ws("x", "Store X")], true);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe("merchant");
  });

  it("routes each kind to its own surface home", () => {
    expect(surfaceHomeForKind("fulfillment_operator")).toBe("/fulfillment-operator/tickets");
    expect(surfaceHomeForKind("merchant")).toBe("/");
  });
});
