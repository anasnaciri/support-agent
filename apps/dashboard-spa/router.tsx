import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AuthedLayout } from "@/components/shell/DashboardShell";
import { HomePage } from "@/features/home/HomePage";
import { Placeholder } from "@/features/placeholder";
import {
  GoodbyePage,
  NoAccessPage,
  OnboardingPage,
  SignInPage,
} from "@/features/auth/pages";

// Code-based route tree (we deliberately skip the generated route tree + type
// registration, keeping `to` loose as `string` so the next/link shim works).
const rootRoute = createRootRoute({ component: () => <Outlet /> });

// The gated dashboard area: SessionProvider + AppShell wrap every child route.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  component: AuthedLayout,
});

const authedChild = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => authedRoute, path, component });

const homeRoute = authedChild("/", HomePage);
const casesRoute = authedChild("/cases", () => <Placeholder title="Cases" />);
const approvalsRoute = authedChild("/approvals", () => (
  <Placeholder title="Approvals" />
));
const auditRoute = authedChild("/audit", () => <Placeholder title="Audit" />);
const settingsRoute = authedChild("/settings", () => (
  <Placeholder title="Settings" />
));
// Catch every settings subpage (agents, refund-policy, …) until they're ported.
const settingsSplatRoute = authedChild("/settings/$", () => (
  <Placeholder title="Settings" />
));

const publicRoute = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const signInRoute = publicRoute("/sign-in", SignInPage);
const goodbyeRoute = publicRoute("/goodbye", GoodbyePage);
const noAccessRoute = publicRoute("/no-access", NoAccessPage);
const onboardingRoute = publicRoute("/onboarding", OnboardingPage);

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    homeRoute,
    casesRoute,
    approvalsRoute,
    auditRoute,
    settingsRoute,
    settingsSplatRoute,
  ]),
  signInRoute,
  goodbyeRoute,
  noAccessRoute,
  onboardingRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  defaultNotFoundComponent: () => <Placeholder title="Not found" />,
});
