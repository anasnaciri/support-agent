import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

// Regression for the settings-overview bug: a `/settings/$` splat sibling
// (a leftover placeholder from the incremental SPA port) SHADOWED the exact
// `/settings` route, so the overview rendered "This page is being ported to
// the SPA" instead of SettingsPage. This test mirrors router.tsx's flat
// `authedChild` registration (a pathless `authed` parent with absolute-path
// children) and pins the matching invariant so the splat cannot creep back.

const resolveLeafId = (
  paths: ReadonlyArray<string>,
  location: string,
): string | undefined => {
  const root = createRootRoute();
  const authed = createRoute({ getParentRoute: () => root, id: "authed" });
  const children = paths.map((path) =>
    createRoute({ getParentRoute: () => authed, path }),
  );
  const tree = root.addChildren([authed.addChildren(children)]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [location] }),
  });
  const matches = router.matchRoutes(location, {});
  return matches[matches.length - 1]?.routeId;
};

describe("settings route matching", () => {
  it("resolves bare /settings to the overview route (not a splat)", () => {
    expect(resolveLeafId(["/", "/settings", "/settings/usage"], "/settings")).toBe(
      "/authed/settings",
    );
  });

  it("demonstrates the bug: a /settings/$ splat shadows bare /settings", () => {
    // Guard: if anyone re-adds the splat, this documents why it broke the
    // overview — bare /settings falls through to the catch-all.
    expect(
      resolveLeafId(["/settings", "/settings/usage", "/settings/$"], "/settings"),
    ).toBe("/authed/settings/$");
  });

  it("still routes explicit subpages correctly without the splat", () => {
    expect(
      resolveLeafId(["/", "/settings", "/settings/usage"], "/settings/usage"),
    ).toBe("/authed/settings/usage");
  });
});
