import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AuthedLayout } from "@/components/shell/DashboardShell";
import { HomePage } from "@/features/home/HomePage";
import { TicketsPage } from "@/features/tickets/TicketsPage";
import { TicketDetailPage } from "@/features/tickets/TicketDetailPage";
import { ApprovalsPage } from "@/features/approvals/ApprovalsPage";
import { ApprovalDetailPage } from "@/features/approvals/ApprovalDetailPage";
import { UsagePage } from "@/features/usage/UsagePage";
import { SupplierTicketsPage } from "@/features/supplier/SupplierTicketsPage";
import { SupplierTicketDetailPage } from "@/features/supplier/SupplierTicketDetailPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { AccountSettingsPage } from "@/features/settings/AccountSettingsPage";
import { IntegrationsPage } from "@/features/settings/IntegrationsPage";
import { IntegrationDetailPage } from "@/features/settings/IntegrationDetailPage";
import { KnowledgePage } from "@/features/settings/KnowledgePage";
import { KnowledgeDocPage } from "@/features/settings/KnowledgeDocPage";
import { LlmPage } from "@/features/settings/LlmPage";
import { RefundPolicyPage } from "@/features/settings/RefundPolicyPage";
import { BlockedSendersPage } from "@/features/settings/BlockedSendersPage";
import { DiscountPolicyPage } from "@/features/settings/DiscountPolicyPage";
import { ResolutionPolicyPage } from "@/features/settings/ResolutionPolicyPage";
import { NotificationsPage } from "@/features/settings/NotificationsPage";
import { PermissionsPage } from "@/features/settings/PermissionsPage";
import { MembersPage } from "@/features/settings/MembersPage";
import { AgentsPage } from "@/features/settings/AgentsPage";
import { NewAgentPage } from "@/features/settings/NewAgentPage";
import { AgentDetailPage } from "@/features/settings/AgentDetailPage";
import { SuppliersPage } from "@/features/settings/SuppliersPage";
import { SupplierEscalationPage } from "@/features/settings/SupplierEscalationPage";
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
const ticketsRoute = authedChild("/tickets", TicketsPage);
const ticketDetailRoute = authedChild("/tickets/$ticketId", TicketDetailPage);
const approvalsRoute = authedChild("/approvals", ApprovalsPage);
const approvalDetailRoute = authedChild("/approvals/$approvalId", ApprovalDetailPage);
// do not delete: the Audit page route is intentionally hidden for now.
// import { AuditPage } from "@/features/audit/AuditPage";
// const auditRoute = authedChild("/audit", AuditPage);
const settingsRoute = authedChild("/settings", SettingsPage);
const settingsUsageRoute = authedChild("/settings/usage", UsagePage);
// Form-heavy settings pages (Phase 4 tail). Static segments are registered
// before their `$param` siblings (e.g. /settings/agents/new before
// /settings/agents/$agentId) so the static route wins.
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
const settingsResolutionPolicyRoute = authedChild(
  "/settings/resolution-policy",
  ResolutionPolicyPage,
);
const settingsBlockedSendersRoute = authedChild(
  "/settings/blocked-senders",
  BlockedSendersPage,
);
const settingsNotificationsRoute = authedChild(
  "/settings/notifications",
  NotificationsPage,
);
const settingsPermissionsRoute = authedChild(
  "/settings/permissions",
  PermissionsPage,
);
const settingsMembersRoute = authedChild("/settings/members", MembersPage);
const settingsAgentsRoute = authedChild("/settings/agents", AgentsPage);
const settingsNewAgentRoute = authedChild("/settings/agents/new", NewAgentPage);
const settingsAgentDetailRoute = authedChild(
  "/settings/agents/$agentId",
  AgentDetailPage,
);
const settingsSuppliersRoute = authedChild("/settings/suppliers", SuppliersPage);
const settingsSupplierEscalationRoute = authedChild(
  "/settings/supplier-escalation",
  SupplierEscalationPage,
);
const settingsLegalRoute = authedChild("/settings/legal", LegalPage);
const newWorkspaceRoute = authedChild("/workspaces/new", NewWorkspacePage);
const supplierTicketsRoute = authedChild("/supplier/tickets", SupplierTicketsPage);
const supplierTicketDetailRoute = authedChild(
  "/supplier/tickets/$escalationId",
  SupplierTicketDetailPage,
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
    settingsLlmRoute,
    settingsRefundPolicyRoute,
    settingsDiscountPolicyRoute,
    settingsResolutionPolicyRoute,
    settingsBlockedSendersRoute,
    settingsNotificationsRoute,
    settingsPermissionsRoute,
    settingsMembersRoute,
    settingsAgentsRoute,
    settingsNewAgentRoute,
    settingsAgentDetailRoute,
    settingsSuppliersRoute,
    settingsSupplierEscalationRoute,
    settingsLegalRoute,
    newWorkspaceRoute,
    supplierTicketsRoute,
    supplierTicketDetailRoute,
  ]),
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
