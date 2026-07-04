import { describe, expect, it } from "vitest";
import type { RbacPermissionId } from "@support-agent/dashboard-contracts";

import {
  SETTINGS_NAV_GROUPS,
  activeSettingsHref,
  hasAnySettingsAccess,
  visibleSettingsGroups,
} from "../app/settings/_components/settings-nav-items.js";

const perms = (...ids: RbacPermissionId[]): ReadonlySet<RbacPermissionId> =>
  new Set(ids);
const hrefs = (
  groups: ReturnType<typeof visibleSettingsGroups>,
): string[] => groups.flatMap((g) => g.items.map((i) => i.href));

const ALL_ITEMS = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);

const TICKETS: ReadonlyArray<readonly [string, string]> = [
  ["/settings", "/settings"],
  ["/settings/agents", "/settings/agents"],
  ["/settings/agents/refund-review-agent", "/settings/agents"],
  ["/settings/permissions", "/settings/permissions"],
  ["/settings/llm", "/settings/llm"],
  ["/settings/refund-policy", "/settings/refund-policy"],
  ["/settings/knowledge", "/settings/knowledge"],
  ["/settings/knowledge/3f2504e0-4f89-41d3-9a0c-0305e82c3301", "/settings/knowledge"],
  ["/settings/usage", "/settings/usage"],
  ["/settings/integrations", "/settings/integrations"],
  ["/settings/integrations/shopify", "/settings/integrations"],
  ["/settings/notifications", "/settings/notifications"],
  // Supplier escalation lives under the Google Sheets connector now — no
  // standalone nav entry — so its pages keep Integrations highlighted.
  ["/settings/integrations/google_sheets", "/settings/integrations"],
  ["/settings/supplier-escalation", "/settings/integrations"],
  ["/settings/legal", "/settings/legal"],
  ["/settings/account", "/settings/account"],
];

describe("settings nav active matching", () => {
  it.each(TICKETS)("highlights the right item for %s", (pathname, expectedHref) => {
    expect(activeSettingsHref(pathname)).toBe(expectedHref);
  });

  it("highlights exactly one item per known route", () => {
    for (const [pathname] of TICKETS) {
      const matched = ALL_ITEMS.filter((item) => item.match(pathname));
      expect(matched).toHaveLength(1);
    }
  });

  it("has no standalone supplier-escalation nav entry", () => {
    expect(
      ALL_ITEMS.find(
        (item) => item.href === "/settings/integrations/google_sheets",
      ),
    ).toBeUndefined();
  });

  it("keeps Integrations active on the Sheets / supplier pages", () => {
    const integrations = ALL_ITEMS.find(
      (item) => item.href === "/settings/integrations",
    );
    expect(integrations?.match("/settings/integrations/google_sheets")).toBe(
      true,
    );
    expect(integrations?.match("/settings/supplier-escalation")).toBe(true);
  });

  it("returns null for a non-settings path", () => {
    expect(activeSettingsHref("/tickets")).toBeNull();
  });
});

describe("settings nav permission gating", () => {
  it("shows a tickets-only member just the ungated items (Overview, Legal)", () => {
    const visible = hrefs(visibleSettingsGroups(perms("tickets.view")));
    expect(visible).toContain("/settings");
    expect(visible).toContain("/settings/legal");
    expect(visible).not.toContain("/settings/llm");
    expect(visible).not.toContain("/settings/members");
    expect(visible).not.toContain("/settings/account");
  });

  it("shows the AI provider item only with settings.llm", () => {
    expect(hrefs(visibleSettingsGroups(perms("settings.llm")))).toContain(
      "/settings/llm",
    );
    expect(hrefs(visibleSettingsGroups(perms("tickets.view")))).not.toContain(
      "/settings/llm",
    );
  });

  it("shows Members only with members.manage", () => {
    expect(hrefs(visibleSettingsGroups(perms("members.manage")))).toContain(
      "/settings/members",
    );
  });

  it("drops a group when all its items are hidden", () => {
    // tickets.view grants nothing in the Connections group → that group vanishes.
    const groups = visibleSettingsGroups(perms("tickets.view"));
    expect(groups.find((g) => g.label === "Connections")).toBeUndefined();
  });

  it("hasAnySettingsAccess: false for tickets-only, true for any gated perm", () => {
    expect(hasAnySettingsAccess(perms("tickets.view"))).toBe(false);
    expect(hasAnySettingsAccess(perms("approvals.decide"))).toBe(false);
    expect(hasAnySettingsAccess(perms("settings.integrations"))).toBe(true);
    expect(hasAnySettingsAccess(perms("members.manage"))).toBe(true);
  });

  it("an all-permissions member sees every item", () => {
    const all = new Set(
      SETTINGS_NAV_GROUPS.flatMap((g) =>
        g.items.map((i) => i.requires).filter(Boolean),
      ) as RbacPermissionId[],
    );
    const visible = hrefs(visibleSettingsGroups(all));
    for (const item of SETTINGS_NAV_GROUPS.flatMap((g) => g.items)) {
      expect(visible).toContain(item.href);
    }
  });
});
