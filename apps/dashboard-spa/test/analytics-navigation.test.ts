import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRIMARY_NAV } from "../lib/primary-nav";

describe("analytics navigation", () => {
  it("gives merchants a primary Analytics destination", () => {
    expect(
      PRIMARY_NAV.map(({ href, label, requires }) => ({
        href,
        label,
        requires,
      })),
    ).toContainEqual({
      href: "/analytics",
      label: "Analytics",
      requires: "tickets.view",
    });

    const routerSource = readFileSync(
      fileURLToPath(new URL("../router.tsx", import.meta.url)),
      "utf8",
    );
    expect(routerSource).toContain(
      'const analyticsRoute = authedChild("/analytics", AnalyticsPage);',
    );
    expect(routerSource).toMatch(/^\s*analyticsRoute,\s*$/m);
  });
});
