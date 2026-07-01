import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AuthedLayout } from "@/components/shell/DashboardShell";
import { HomePage } from "@/features/home/HomePage";
import { CasesPage } from "@/features/cases/CasesPage";
import { CaseDetailPage } from "@/features/cases/CaseDetailPage";
import { ApprovalsPage } from "@/features/approvals/ApprovalsPage";
import { ApprovalDetailPage } from "@/features/approvals/ApprovalDetailPage";
import { AuditPage } from "@/features/audit/AuditPage";
import { UsagePage } from "@/features/usage/UsagePage";
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

const authedChild = (
  path: string,
  component: () => React.JSX.Element | null,
) => createRoute({ getParentRoute: () => authedRoute, path, component });

const homeRoute = authedChild("/", HomePage);
const casesRoute = authedChild("/cases", CasesPage);
const caseDetailRoute = authedChild("/cases/$caseId", CaseDetailPage);
const approvalsRoute = authedChild("/approvals", ApprovalsPage);
const approvalDetailRoute = authedChild("/approvals/$approvalId", ApprovalDetailPage);
const auditRoute = authedChild("/audit", AuditPage);
const settingsRoute = authedChild("/settings", () => (
  <Placeholder title="Settings" />
));
const settingsUsageRoute = authedChild("/settings/usage", UsagePage);
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
    caseDetailRoute,
    approvalsRoute,
    approvalDetailRoute,
    auditRoute,
    settingsRoute,
    settingsUsageRoute,
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
