import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import { handleDashboardAccountDelete } from "../admin/account-handlers.js";
import {
  handleDashboardAgentOverrides,
  handleDashboardApprovalAction,
  handleDashboardApprovalDetail,
  handleDashboardApprovals,
  handleDashboardAudit,
  handleDashboardCaseConversationThread,
  handleDashboardCaseDetail,
  handleDashboardCaseEvents,
  handleDashboardCaseReply,
  handleDashboardIssueRefund,
  handleDashboardRephrase,
  handleDashboardCaseShopify,
  handleDashboardCases,
  handleDashboardConnections,
  handleDashboardResume,
  handleDashboardRetry,
  handleDashboardRetrySend,
  handleDashboardSetCaseStatus,
  handleDashboardShopifyApp,
  handleDashboardTakeover,
  handleDashboardToday,
  handleDashboardUsage,
} from "./case-handlers.js";
import {
  handleDashboardAgentModelClear,
  handleDashboardAgentModelSet,
  handleDashboardAgentSystemPromptClear,
  handleDashboardAgentSystemPromptSet,
  handleDashboardAgentToolPermissionClear,
  handleDashboardAgentToolPermissionSet,
  handleDashboardCatalog,
  handleDashboardLegalAcceptance,
  handleDashboardLlmStatus,
  handleDashboardModels,
  handleDashboardRephraseModelSet,
  handleDashboardOnboarding,
  handleDashboardSettings,
  handleDashboardShopCurrency,
  handleDashboardTenant,
  handleDashboardWorkspaceCreate,
  handleDashboardWorkspaceDelete,
  handleDashboardWorkspaceRename,
  handleDashboardWorkspaces,
} from "./settings-handlers.js";
import {
  handleDashboardCustomAgentCreate,
  handleDashboardCustomAgentDelete,
  handleDashboardCustomAgentGet,
  handleDashboardCustomAgentUpdate,
} from "./custom-agent-handlers.js";
import {
  handleDashboardKnowledgeCreate,
  handleDashboardKnowledgeDelete,
  handleDashboardKnowledgeGet,
  handleDashboardKnowledgeList,
  handleDashboardKnowledgeResync,
  handleDashboardKnowledgeUpdate,
} from "./knowledge-handlers.js";
import {
  handleDashboardConnect,
  handleDashboardConnectImap,
  handleDashboardConnectTelegram,
  handleDashboardDisconnect,
  handleDashboardImapDiscover,
  handleDashboardLlmConnect,
  handleDashboardLlmRevoke,
  handleDashboardRefundPolicy,
  handleDashboardSupplierSheet,
  handleDashboardSupplierSheetClear,
} from "./connect-handlers.js";

export const registerDashboardRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
): void => {
  const { dashboardGet, dashboardPost } = makeDashboardRoutes(app, ctx);

  // ---- Dashboard read API ----
  dashboardGet("/dashboard/today", "Today-view rollup", handleDashboardToday, "cases.view");
  dashboardGet("/dashboard/cases", "Paginated cases list", handleDashboardCases, "cases.view");
  dashboardGet(
    "/dashboard/cases/:id",
    "Case detail with timeline + approvals",
    handleDashboardCaseDetail,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/conversation-thread",
    "Live customer email thread for a case",
    handleDashboardCaseConversationThread,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/events",
    "New audit events for a case since ?since=",
    handleDashboardCaseEvents,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/cases/:id/shopify",
    "Case-detail Shopify customer/order panels",
    handleDashboardCaseShopify,
    "cases.view",
  );
  dashboardGet(
    "/dashboard/approvals",
    "Paginated approvals list with facets",
    handleDashboardApprovals,
    "approvals.view",
  );
  dashboardGet(
    "/dashboard/approvals/:id",
    "Approval detail",
    handleDashboardApprovalDetail,
    "approvals.view",
  );
  dashboardGet("/dashboard/audit", "Cross-case audit log", handleDashboardAudit, "audit.view");
  dashboardGet(
    "/dashboard/shopify-app",
    "Shopify connect gate (pilot provisioning status)",
    handleDashboardShopifyApp,
    "settings.integrations",
  );
  dashboardGet(
    "/dashboard/connections",
    "Connector connections (integrations)",
    handleDashboardConnections,
    "settings.integrations",
  );
  dashboardGet(
    "/dashboard/usage",
    "LLM usage rows in a time window",
    handleDashboardUsage,
    "audit.view",
  );
  dashboardGet(
    "/dashboard/agent-overrides",
    "Per-agent model overrides",
    handleDashboardAgentOverrides,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/knowledge",
    "Knowledge-base document summaries",
    handleDashboardKnowledgeList,
    "knowledge.view",
  );
  dashboardGet(
    "/dashboard/knowledge/:id",
    "One knowledge document (full content)",
    handleDashboardKnowledgeGet,
    "knowledge.view",
  );
  dashboardGet(
    "/dashboard/catalog",
    "Agent + tool inventory",
    handleDashboardCatalog,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/custom-agents/:id",
    "One custom agent (editable view)",
    handleDashboardCustomAgentGet,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/models",
    "Tenant LLM model catalog",
    handleDashboardModels,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/llm",
    "Effective workspace/account LLM credential status",
    handleDashboardLlmStatus,
    "settings.llm",
  );
  // Pre-tenant / org-scoped reads — reachable by any signed-in org member (no
  // per-workspace RBAC; they're how the dashboard bootstraps its context).
  dashboardGet(
    "/dashboard/tenant",
    "The org's tenant (or null → onboarding)",
    handleDashboardTenant,
  );
  dashboardGet(
    "/dashboard/workspaces",
    "The org's workspaces, default first",
    handleDashboardWorkspaces,
  );
  // Low-sensitivity resolved settings (refund numbers, currency) consumed by
  // shared UI; the admin pages that EDIT them are redirect-gated and the write
  // endpoints below are permission-gated.
  dashboardGet(
    "/dashboard/settings",
    "Resolved tenant settings (refund policy + supplier sheet)",
    handleDashboardSettings,
  );
  dashboardGet(
    "/dashboard/shop-currency",
    "Best-effort Shopify store currency (ISO 4217) or null",
    handleDashboardShopCurrency,
  );

  // ---- Dashboard write API ----
  dashboardPost(
    "/dashboard/approvals/:id/approve",
    "Approve an approval (manager)",
    handleDashboardApprovalAction("approve"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/approvals/:id/reject",
    "Reject an approval (manager)",
    handleDashboardApprovalAction("reject"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/cases/:id/takeover",
    "Take over a case (manager)",
    handleDashboardTakeover,
    "cases.takeover",
  );
  dashboardPost(
    "/dashboard/cases/:id/resume",
    "Hand a taken-over case back to the agent (manager)",
    handleDashboardResume,
    "cases.resume",
  );
  dashboardPost(
    "/dashboard/cases/:id/status",
    "Manually set a case's status (manager)",
    handleDashboardSetCaseStatus,
    "cases.set_status",
  );
  dashboardPost(
    "/dashboard/cases/:id/retry",
    "Hand a taken-over case back and have the agent retry now (manager)",
    handleDashboardRetry,
    "cases.retry",
  );
  dashboardPost(
    "/dashboard/cases/:id/retry-send",
    "Re-send the drafted customer reply whose delivery failed (manager)",
    handleDashboardRetrySend,
    "cases.retry",
  );
  dashboardPost(
    "/dashboard/cases/:id/reply",
    "Send a human-drafted customer reply while driving a taken-over case",
    handleDashboardCaseReply,
    "cases.reply",
  );
  dashboardPost(
    "/dashboard/cases/:id/refund",
    "Issue an agent-recommended refund on a case (manager)",
    handleDashboardIssueRefund,
    "refunds.issue",
  );
  dashboardPost(
    "/dashboard/rephrase",
    "AI-polish a reply draft (one-shot, spent against the tenant's LLM key)",
    handleDashboardRephrase,
    "cases.reply",
  );
  // Org-scoped (no resolved workspace) — these use authenticateDashboardOrg and
  // remain reachable by any org member; workspace/account management is an
  // org-level concern, hidden cosmetically from non-admins in the dashboard.
  dashboardPost(
    "/dashboard/onboarding",
    "Create a tenant for the org",
    handleDashboardOnboarding,
  );
  dashboardPost(
    "/dashboard/workspaces",
    "Create an additional workspace under the org",
    handleDashboardWorkspaceCreate,
  );
  dashboardPost(
    "/dashboard/workspaces/:id/rename",
    "Rename a workspace",
    handleDashboardWorkspaceRename,
  );
  dashboardPost(
    "/dashboard/workspaces/:id/delete",
    "Delete one workspace (org + siblings survive)",
    handleDashboardWorkspaceDelete,
  );
  dashboardPost(
    "/dashboard/legal-acceptance",
    "Accept the current data processing notice + DPA",
    handleDashboardLegalAcceptance,
    "account.manage",
  );
  dashboardPost(
    "/dashboard/agents/:id/model",
    "Set a per-agent model override",
    handleDashboardAgentModelSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/settings/rephrase-model",
    "Set (or clear) the model used by the Rephrase with AI composer action",
    handleDashboardRephraseModelSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/model/clear",
    "Clear a per-agent model override",
    handleDashboardAgentModelClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/system-prompt",
    "Set a per-agent system prompt (appended to the built-in prompt)",
    handleDashboardAgentSystemPromptSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/system-prompt/clear",
    "Clear a per-agent system prompt",
    handleDashboardAgentSystemPromptClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/tool-permission",
    "Set a per-agent tool permission (ask first vs auto)",
    handleDashboardAgentToolPermissionSet,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/agents/:id/tool-permission/clear",
    "Clear a per-agent tool permission override",
    handleDashboardAgentToolPermissionClear,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/custom-agents",
    "Create a merchant-authored custom agent",
    handleDashboardCustomAgentCreate,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/custom-agents/:id",
    "Update a custom agent's editable fields",
    handleDashboardCustomAgentUpdate,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/custom-agents/:id/delete",
    "Delete a custom agent",
    handleDashboardCustomAgentDelete,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/knowledge",
    "Create a knowledge document (paste or fetch a URL)",
    handleDashboardKnowledgeCreate,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id",
    "Update a knowledge document (title / text content)",
    handleDashboardKnowledgeUpdate,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id/delete",
    "Delete a knowledge document",
    handleDashboardKnowledgeDelete,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/knowledge/:id/resync",
    "Re-fetch a URL document's snapshot",
    handleDashboardKnowledgeResync,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/llm",
    "Connect a BYOK LLM credential",
    handleDashboardLlmConnect,
    "settings.llm",
  );
  dashboardPost(
    "/dashboard/llm/revoke",
    "Revoke the tenant's LLM credential",
    handleDashboardLlmRevoke,
    "settings.llm",
  );
  dashboardPost(
    "/dashboard/refund-policy",
    "Set the conditional refund policy",
    handleDashboardRefundPolicy,
    "settings.refund_policy",
  );
  dashboardPost(
    "/dashboard/supplier-sheet",
    "Set the supplier-escalation sheet",
    handleDashboardSupplierSheet,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/supplier-sheet/clear",
    "Clear the supplier-escalation sheet",
    handleDashboardSupplierSheetClear,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connect/:provider",
    "Mint a signed install grant + return the provider install URL",
    handleDashboardConnect,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/imap",
    "Connect a generic IMAP/SMTP mailbox (credentials, no OAuth)",
    handleDashboardConnectImap,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/imap/discover",
    "Autodiscover IMAP/SMTP settings for a mailbox address",
    handleDashboardImapDiscover,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/connections/telegram",
    "Mint a Telegram notification-channel linking deep link",
    handleDashboardConnectTelegram,
    "settings.notifications",
  );
  dashboardPost(
    "/dashboard/connections/:provider/disconnect",
    "Disconnect (revoke) a connector",
    handleDashboardDisconnect,
    "settings.integrations",
  );
  // Org-scoped (authenticateDashboardOrg) — deletes the whole account.
  dashboardPost(
    "/dashboard/account/delete",
    "Delete the tenant's own account (irreversible)",
    handleDashboardAccountDelete,
  );
};
