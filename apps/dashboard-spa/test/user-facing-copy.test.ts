import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("user-facing copy style", () => {
  it("keeps em dashes out of scenario and notification copy", () => {
    const files = [
      "features/settings/ScenariosPage.tsx",
      "features/settings/NotificationsPage.tsx",
      "lib/ticket-action-feedback.ts",
    ];

    for (const file of files) {
      const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).not.toContain("—");
    }
  });
});
