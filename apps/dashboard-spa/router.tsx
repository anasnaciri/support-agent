import * as React from "react";
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  AuthedBareLayout,
  AuthedLayout,
} from "@/components/shell/DashboardShell";
import { WelcomePage } from "@/features/onboarding/WelcomePage";
import { HomePage } from "@/features/home/HomePage";
import { AnalyticsPage } from "@/features/analytics/AnalyticsPage";
import { TicketsPage } from "@/features/tickets/TicketsPage";
import { TicketDetailPage } from "@/features/tickets/TicketDetailPage";
import { ApprovalsPage } from "@/features/approvals/ApprovalsPage";
import { ApprovalDetailPage } from "@/features/approvals/ApprovalDetailPage";
import { UsagePage } from "@/features/usage/UsagePage";
import { FulfillmentOperatorTicketsPage } from "@/features/fulfillment-operator/FulfillmentOperatorTicketsPage";
import { FulfillmentOperatorTicketDetailPage } from "@/features/fulfillment-operator/FulfillmentOperatorTicketDetailPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { AccountSettingsPage } from "@/features/settings/AccountSettingsPage";
import { IntegrationsPage } from "@/features/settings/IntegrationsPage";
import { IntegrationDetailPage } from "@/features/settings/IntegrationDetailPage";
import { FactsPage } from "@/features/settings/FactsPage";
import { KnowledgePage } from "@/features/settings/KnowledgePage";
import { KnowledgeDocPage } from "@/features/settings/KnowledgeDocPage";
import { LlmPage } from "@/features/settings/LlmPage";
import { RefundPolicyPage } from "@/features/settings/RefundPolicyPage";
import { BlockedSendersPage } from "@/features/settings/BlockedSendersPage";
import { DiscountPolicyPage } from "@/features/settings/DiscountPolicyPage";
import { ScenariosPage } from "@/features/settings/ScenariosPage";
import { NotificationsPage } from "@/features/settings/NotificationsPage";
import { MembersPage } from "@/features/settings/MembersPage";
import { AgentPage } from "@/features/settings/AgentPage";
import { FulfillmentOperatorsPage } from "@/features/settings/FulfillmentOperatorsPage";
import { FulfillmentOperatorEscalationPage } from "@/features/settings/FulfillmentOperatorEscalationPage";
import { LegalPage } from "@/features/settings/LegalPage";
import { NotFoundPage } from "@/features/not-found/NotFoundPage";
import { NewWorkspacePage } from "@/features/workspaces/NewWorkspacePage";
import {
  GoodbyePage,
  NoAccessPage,
  OnboardingPage,
  SignInPage,
  SignUpPage,
} from "@/features/auth/pages";
import { useAppNavigate } from "@/lib/navigation";

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

// Authed but shell-less: the setup wizard owns the whole screen. Note the
// SEPARATE parent route — nesting it under `authedRoute` would wrap it in the
// AppShell, whose gate would then redirect it to itself, forever.
const authedBareRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed-bare",
  component: AuthedBareLayout,
});

const welcomeRoute = createRoute({
  getParentRoute: () => authedBareRoute,
  path: "/welcome",
  component: WelcomePage,
});

const ClientRedirect = ({ to }: { readonly to: string }) => {
  const nav = useAppNavigate();
  React.useEffect(() => {
    nav.replace(to);
  }, [nav, to]);
  return null;
};

const homeRoute = authedChild("/", HomePage);
const analyticsRoute = authedChild("/analytics", AnalyticsPage);
const ticketsRoute = authedChild("/tickets", TicketsPage);
const ticketDetailRoute = authedChild("/tickets/$ticketId", TicketDetailPage);
const approvalsRoute = authedChild("/approvals", ApprovalsPage);
const approvalDetailRoute = authedChild("/approvals/$approvalId", ApprovalDetailPage);
// do not delete: the Audit page route is intentionally hidden for now.
// import { AuditPage } from "@/features/audit/AuditPage";
// const auditRoute = authedChild("/audit", AuditPage);
const settingsRoute = authedChild("/settings", SettingsPage);
const settingsUsageRoute = authedChild("/settings/usage", UsagePage);
// Form-heavy settings pages (Phase 4 tail).
const settingsAccountRoute = authedChild("/settings/account", AccountSettingsPage);
const settingsIntegrationsRoute = authedChild(
  "/settings/integrations",
  IntegrationsPage,
);
const settingsIntegrationDetailRoute = authedChild(
  "/settings/integrations/$provider",
  IntegrationDetailPage,
);
const settingsKnowledgeRoute = authedChild("/settings/knowledge", KnowledgePage);
const settingsFactsRoute = authedChild("/settings/facts", FactsPage);
const settingsKnowledgeDocRoute = authedChild(
  "/settings/knowledge/$docId",
  KnowledgeDocPage,
);
const settingsLlmRoute = authedChild("/settings/llm", LlmPage);
const settingsRefundPolicyRoute = authedChild(
  "/settings/refund-policy",
  RefundPolicyPage,
);
const settingsDiscountPolicyRoute = authedChild(
  "/settings/discount-policy",
  DiscountPolicyPage,
);
const settingsScenariosRoute = authedChild("/settings/scenarios", ScenariosPage);
const settingsResolutionPolicyRoute = authedChild("/settings/resolution-policy", () => (
  <ClientRedirect to="/settings/scenarios" />
));
const settingsBlockedSendersRoute = authedChild(
  "/settings/blocked-senders",
  BlockedSendersPage,
);
const settingsNotificationsRoute = authedChild(
  "/settings/notifications",
  NotificationsPage,
);
const settingsMembersRoute = authedChild("/settings/members", MembersPage);
const settingsAgentRoute = authedChild("/settings/agent", AgentPage);
const settingsAgentsRoute = authedChild("/settings/agents", () => (
  <ClientRedirect to="/settings/agent" />
));
// Legacy deep links from the multi-agent era (/settings/agents/new,
// /settings/agents/<id>) all collapse into the single agent page. This splat
// outranks the bare /settings/agents sibling for that path too (the
// settings-overview shadowing lesson), which is harmless here: both redirect
// to the same target.
const settingsAgentsSplatRoute = authedChild("/settings/agents/$", () => (
  <ClientRedirect to="/settings/agent" />
));
// The permissions matrix moved onto the agent page's Actions card.
const settingsPermissionsRoute = authedChild("/settings/permissions", () => (
  <ClientRedirect to="/settings/agent" />
));
const settingsFulfillmentOperatorsRoute = authedChild("/settings/fulfillment-operators", FulfillmentOperatorsPage);
const settingsFulfillmentOperatorEscalationRoute = authedChild(
  "/settings/fulfillment-operator-escalation",
  FulfillmentOperatorEscalationPage,
);
const settingsLegalRoute = authedChild("/settings/legal", LegalPage);
const newWorkspaceRoute = authedChild("/workspaces/new", NewWorkspacePage);
const fulfillmentOperatorTicketsRoute = authedChild("/fulfillment-operator/tickets", FulfillmentOperatorTicketsPage);
const fulfillmentOperatorTicketDetailRoute = authedChild(
  "/fulfillment-operator/tickets/$escalationId",
  FulfillmentOperatorTicketDetailPage,
);

const publicRoute = (path: string, component: () => React.JSX.Element) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

const signInRoute = publicRoute("/sign-in", SignInPage);
const signUpRoute = publicRoute("/sign-up", SignUpPage);
const goodbyeRoute = publicRoute("/goodbye", GoodbyePage);
const noAccessRoute = publicRoute("/no-access", NoAccessPage);
const onboardingRoute = publicRoute("/onboarding", OnboardingPage);

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    homeRoute,
    analyticsRoute,
    ticketsRoute,
    ticketDetailRoute,
    approvalsRoute,
    approvalDetailRoute,
    // do not delete: keep the hidden Audit route available to restore later.
    // auditRoute,
    settingsRoute,
    settingsUsageRoute,
    settingsAccountRoute,
    settingsIntegrationsRoute,
    settingsIntegrationDetailRoute,
    settingsKnowledgeRoute,
    settingsKnowledgeDocRoute,
    settingsFactsRoute,
    settingsLlmRoute,
    settingsRefundPolicyRoute,
    settingsDiscountPolicyRoute,
    settingsScenariosRoute,
    settingsResolutionPolicyRoute,
    settingsBlockedSendersRoute,
    settingsNotificationsRoute,
    settingsMembersRoute,
    settingsAgentRoute,
    settingsAgentsRoute,
    settingsAgentsSplatRoute,
    settingsPermissionsRoute,
    settingsFulfillmentOperatorsRoute,
    settingsFulfillmentOperatorEscalationRoute,
    settingsLegalRoute,
    newWorkspaceRoute,
    fulfillmentOperatorTicketsRoute,
    fulfillmentOperatorTicketDetailRoute,
  ]),
  authedBareRoute.addChildren([welcomeRoute]),
  signInRoute,
  signUpRoute,
  goodbyeRoute,
  noAccessRoute,
  onboardingRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  defaultNotFoundComponent: NotFoundPage,
});
