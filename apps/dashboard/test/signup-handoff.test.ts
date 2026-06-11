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
    expect(action).toContain("/sign-up/start");
    expect(startRoute).toContain("getSignUpUrl");
    // The GET route is where returnTo is resolved (defaulting to onboarding for
    // a fresh sign-up) and handed to WorkOS — see the returnTo handoff test.
    expect(startRoute).toContain("getSignUpUrl({ returnTo })");
    expect(startRoute).toContain('"/onboarding"');
  });

  it("threads a returnTo through the form → action → GET route → WorkOS", () => {
    const form = readDashboardFile("app/sign-up/SignUpForm.tsx");
    const action = readDashboardFile("app/sign-up/actions.ts");
    const startRoute = readDashboardFile("app/sign-up/start/route.ts");

    // The form forwards the page-to-return-to as a hidden field…
    expect(form).toContain('name="returnTo"');
    // …the action reads it and appends it to the GET handoff…
    expect(action).toContain('formData.get("returnTo")');
    expect(action).toContain("returnTo=");
    // …and the GET route reads it back off the query before signing in.
    expect(startRoute).toContain('searchParams.get("returnTo")');
    // Always sanitised — never a raw redirect target (open-redirect guard).
    expect(action).toContain("sanitizeReturnTo");
    expect(startRoute).toContain("sanitizeReturnTo");
  });

  it("signs out via a POST server action, never a (prefetchable) GET link", () => {
    // S13 strengthened the old "prefetch={false}" guard: sign-out mutates
    // state (cookie clear + WorkOS session termination), so it's a server
    // action submitted by a form in the icon rail — there is no /sign-out
    // GET route left to prefetch or drive-by.
    const iconRail = readDashboardFile("app/IconRail.tsx");
    const action = readDashboardFile("app/sign-out-action.ts");

    expect(iconRail).toContain("form action={signOutAction}");
    expect(iconRail).not.toContain('href="/sign-out"');
    expect(action).toContain('"use server"');
    expect(action).toContain("signOut()");
  });
});
