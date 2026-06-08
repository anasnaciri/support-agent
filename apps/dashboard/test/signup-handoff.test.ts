import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dashboardRoot = fileURLToPath(new URL("..", import.meta.url));

const readDashboardFile = (path: string) =>
  readFileSync(`${dashboardRoot}/${path}`, "utf8");

describe("sign-up OAuth handoff", () => {
  it("creates the AuthKit verifier cookie from a GET route, not a server action", () => {
    const action = readDashboardFile("app/sign-up/actions.ts");
    const startRoute = readDashboardFile("app/sign-up/start/route.ts");

    expect(action).not.toContain("getSignUpUrl");
    expect(action).toContain('redirect("/sign-up/start")');
    expect(startRoute).toContain("getSignUpUrl");
    expect(startRoute).toContain('returnTo: "/onboarding"');
  });

  it("never prefetches the sign-out route that clears verifier cookies", () => {
    // The sign-out link lives in the icon rail of the app shell.
    const iconRail = readDashboardFile("app/IconRail.tsx");

    expect(iconRail).toMatch(
      /<Link\s+href="\/sign-out"\s+prefetch=\{false\}/,
    );
  });
});
