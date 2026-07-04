import { describe, expect, it } from "vitest";
import {
  RBAC_PERMISSIONS,
  RBAC_PERMISSION_IDS,
  effectivePermissions,
  hasPermission,
  type RbacPermissionId,
} from "../src/index.js";

describe("RBAC permission registry", () => {
  it("has unique ids and a non-empty label/description/category per entry", () => {
    const ids = RBAC_PERMISSIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of RBAC_PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.category.length).toBeGreaterThan(0);
    }
  });

  it("only references real ids in every `implies` list", () => {
    for (const p of RBAC_PERMISSIONS) {
      for (const implied of p.implies ?? []) {
        expect(RBAC_PERMISSION_IDS.has(implied)).toBe(true);
      }
    }
  });

  it("exposes RBAC_PERMISSION_IDS matching the registry", () => {
    expect(RBAC_PERMISSION_IDS.size).toBe(RBAC_PERMISSIONS.length);
    for (const p of RBAC_PERMISSIONS) {
      expect(RBAC_PERMISSION_IDS.has(p.id)).toBe(true);
    }
  });
});

describe("effectivePermissions", () => {
  it("grants every permission to an owner regardless of grantedIds", () => {
    const perms = effectivePermissions({ isOwner: true, grantedIds: [] });
    expect(perms.size).toBe(RBAC_PERMISSIONS.length);
    for (const p of RBAC_PERMISSIONS) {
      expect(perms.has(p.id)).toBe(true);
    }
  });

  it("expands the implied closure (cases.reply ⇒ cases.view)", () => {
    const perms = effectivePermissions({
      isOwner: false,
      grantedIds: ["cases.reply"],
    });
    expect(perms.has("cases.reply")).toBe(true);
    expect(perms.has("cases.view")).toBe(true);
    // No unrelated permission leaks in.
    expect(perms.has("audit.view")).toBe(false);
  });

  it("expands orders.edit ⇒ cases.view (a store write performed from a case)", () => {
    const perms = effectivePermissions({
      isOwner: false,
      grantedIds: ["orders.edit"],
    });
    expect(perms.has("orders.edit")).toBe(true);
    expect(perms.has("cases.view")).toBe(true);
    // A store write never rides along with case-state correction (or vice
    // versa) — a role must grant each explicitly.
    expect(perms.has("cases.set_status")).toBe(false);
  });

  it("expands approvals.decide ⇒ approvals.view and knowledge.manage ⇒ knowledge.view", () => {
    const a = effectivePermissions({
      isOwner: false,
      grantedIds: ["approvals.decide"],
    });
    expect(a.has("approvals.view")).toBe(true);
    const k = effectivePermissions({
      isOwner: false,
      grantedIds: ["knowledge.manage"],
    });
    expect(k.has("knowledge.view")).toBe(true);
  });

  it("does NOT make refunds.issue imply approvals.decide (both must be granted)", () => {
    const perms = effectivePermissions({
      isOwner: false,
      grantedIds: ["refunds.issue"],
    });
    expect(perms.has("refunds.issue")).toBe(true);
    expect(perms.has("approvals.decide")).toBe(false);
  });

  it("ignores unknown ids", () => {
    const perms = effectivePermissions({
      isOwner: false,
      grantedIds: ["cases.view", "not.a.real.perm"],
    });
    expect(perms.has("cases.view")).toBe(true);
    expect((perms as ReadonlySet<string>).has("not.a.real.perm")).toBe(false);
  });
});

describe("hasPermission", () => {
  it("returns true only for a present permission", () => {
    const perms = effectivePermissions({
      isOwner: false,
      grantedIds: ["cases.reply"],
    });
    expect(hasPermission(perms, "cases.view" as RbacPermissionId)).toBe(true);
    expect(hasPermission(perms, "settings.llm" as RbacPermissionId)).toBe(false);
  });
});
