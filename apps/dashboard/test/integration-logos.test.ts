import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));
const shared = readFileSync(
  `${dashboardRoot}/app/settings/integrations/_shared.tsx`,
  "utf8",
);

const brandedIcons = [
  ["GmailIcon", "Gmail_icon_(2026).svg"],
  ["GoogleSheetsIcon", "Google_Sheets_icon_(2026).svg"],
  ["OutlookIcon", "Microsoft_Outlook_Icon_(2025–present).svg"],
] as const;

describe("integration logos", () => {
  it.each(brandedIcons)(
    "renders %s from its logo asset instead of inline svg markup",
    (component, filename) => {
      const componentSource = shared.match(
        new RegExp(`const ${component} = \\(\\) => \\(([\\s\\S]*?)\\n\\);`),
      )?.[1];

      expect(shared).toContain(`from "./_logos/${filename}"`);
      expect(componentSource).toContain("<Image");
      expect(componentSource).not.toContain("<svg");
    },
  );
});
