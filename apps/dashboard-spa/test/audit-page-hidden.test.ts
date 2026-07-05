import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRIMARY_NAV } from "../lib/primary-nav";

const spaFile = (path: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    "utf8",
  );

describe("hidden audit page", () => {
  it("keeps the audit page source but does not register the /audit route", () => {
    const routerSource = spaFile("router.tsx");
    const auditPageSource = spaFile("features/audit/AuditPage.tsx");

    expect(auditPageSource).toContain("export function AuditPage");
    expect(routerSource).not.toMatch(
      /^\s*const auditRoute = authedChild\("\/audit"/m,
    );
    expect(routerSource).not.toMatch(/^\s*auditRoute,\s*$/m);
    expect(routerSource.toLowerCase()).toContain("do not delete");
  });

  it("does not show Audit in the primary sidebar nav", () => {
    expect(PRIMARY_NAV.map((item) => item.href)).not.toContain("/audit");
  });
});
