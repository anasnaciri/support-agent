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
});

describe("mergeWorkspaces", () => {
  const merchant = [ws("m1", "My Store"), ws("m2", "Second Store")];
  const supplier = [ws("s1", "Vendor A"), ws("s2", "Vendor B")];

  it("tags merchant + supplier entries and lists merchant first", () => {
    const merged = mergeWorkspaces(merchant, supplier, true);
    expect(merged.map((w) => [w.id, w.kind])).toEqual([
      ["m1", "merchant"],
      ["m2", "merchant"],
      ["s1", "supplier"],
      ["s2", "supplier"],
    ]);
  });

  it("drops the merchant portion for a pure supplier (includeMerchant=false)", () => {
    const merged = mergeWorkspaces(merchant, supplier, false);
    expect(merged.map((w) => w.id)).toEqual(["s1", "s2"]);
    expect(merged.every((w) => w.kind === "supplier")).toBe(true);
  });

  it("dedupes a workspace present in both lists — merchant wins", () => {
    const merged = mergeWorkspaces([ws("x", "Store X")], [ws("x", "Store X")], true);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe("merchant");
  });

  it("routes each kind to its own surface home", () => {
    expect(surfaceHomeForKind("supplier")).toBe("/supplier/tickets");
    expect(surfaceHomeForKind("merchant")).toBe("/");
  });
});
