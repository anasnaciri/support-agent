import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

// The 2026-07-06 settings simplification removed /settings/permissions and the
// multi-agent pages, but only /settings/resolution-policy and the bare
// /settings/agents got ClientRedirects — /settings/permissions and deep agent
// links (/settings/agents/new, /settings/agents/<id>) fell to the 404 page.
// Old bookmarks and emailed links should land on the replacement instead:
// the permissions matrix lives on /settings/agent (Actions card), and every
// old per-agent page collapses into the same single agent page.

const routerSource = readFileSync(
  fileURLToPath(new URL("../router.tsx", import.meta.url)),
  "utf8",
);

const redirectRoute = (path: string): RegExp =>
  new RegExp(
    `authedChild\\("${path.replaceAll("$", "\\$")}", \\(\\) => \\(\\s*<ClientRedirect to="/settings/agent"`,
  );

describe("legacy settings redirects", () => {
  it("redirects the removed /settings/permissions page to /settings/agent", () => {
    expect(routerSource).toMatch(redirectRoute("/settings/permissions"));
  });

  it("redirects old agent deep links (/settings/agents/*) to /settings/agent", () => {
    expect(routerSource).toMatch(redirectRoute("/settings/agents/$"));
  });
});

// Matching pin for the new splat, honoring the settings-overview lesson
// (a same-prefix splat outranks the bare static route): /settings/agents/$
// may only ever sit beside routes that redirect to the same target, and it
// must not leak onto the distinct /settings/agent page.
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

const AGENT_PATHS = ["/settings/agent", "/settings/agents", "/settings/agents/$"];

describe("agents splat matching", () => {
  it("catches old agent deep links", () => {
    expect(resolveLeafId(AGENT_PATHS, "/settings/agents/new")).toBe(
      "/authed/settings/agents/$",
    );
    expect(resolveLeafId(AGENT_PATHS, "/settings/agents/abc-123")).toBe(
      "/authed/settings/agents/$",
    );
  });

  it("does not shadow the distinct /settings/agent page", () => {
    expect(resolveLeafId(AGENT_PATHS, "/settings/agent")).toBe(
      "/authed/settings/agent",
    );
  });
});
