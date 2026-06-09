import { describe, expect, it } from "vitest";

import {
  SETTINGS_NAV_GROUPS,
  activeSettingsHref,
} from "../app/settings/_components/settings-nav-items.js";

const ALL_ITEMS = SETTINGS_NAV_GROUPS.flatMap((g) => g.items);

const CASES: ReadonlyArray<readonly [string, string]> = [
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
  // Supplier escalation lives under the Google Sheets connector now — no
  // standalone nav entry — so its pages keep Integrations highlighted.
  ["/settings/integrations/google_sheets", "/settings/integrations"],
  ["/settings/supplier-escalation", "/settings/integrations"],
  ["/settings/legal", "/settings/legal"],
  ["/settings/account", "/settings/account"],
];

describe("settings nav active matching", () => {
  it.each(CASES)("highlights the right item for %s", (pathname, expectedHref) => {
    expect(activeSettingsHref(pathname)).toBe(expectedHref);
  });

  it("highlights exactly one item per known route", () => {
    for (const [pathname] of CASES) {
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
    expect(activeSettingsHref("/cases")).toBeNull();
  });
});
