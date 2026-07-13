import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../../platform/context.js";
import { makeDashboardRoutes } from "../../auth/dashboard-routes.js";
import { handleDashboardAccountDelete } from "../admin/account-handlers.js";
import {
  handleDashboardAgentOverrides,
  handleDashboardApprovalAction,
  handleDashboardTicketApprovalsBundle,
  handleDashboardApprovalDetail,
  handleDashboardApprovals,
  handleDashboardAudit,
  handleDashboardTicketConversationThread,
  handleDashboardTicketDetail,
  handleDashboardTicketEvents,
  handleDashboardTicketReply,
  handleDashboardTicketAttachmentUpload,
  handleDashboardTicketAttachments,
  handleDashboardTicketAttachmentUrl,
  handleDashboardEditTicketDetails,
  handleDashboardEditShippingAddress,
  handleDashboardEscalateFulfillmentOperator,
  handleDashboardIssueRefund,
  handleDashboardCancelOrder,
  handleDashboardRefundContext,
  handleDashboardRephrase,
  handleDashboardTicketShopify,
  handleDashboardTickets,
  handleDashboardTicketTracking,
  handleDashboardConnections,
  handleDashboardResendApproval,
  handleDashboardResolveTicket,
  handleDashboardResume,
  handleDashboardRetry,
  handleDashboardRetrySend,
  handleDashboardSetTicketStatus,
  handleDashboardShopifyApp,
  handleDashboardBlockTicketSender,
  handleDashboardTakeover,
  handleDashboardToday,
  handleDashboardUsage,
} from "./ticket-handlers.js";
import {
  handleDashboardAgentModelClear,
  handleDashboardAgentModelSet,
  handleDashboardBlockedSenders,
  handleDashboardBlockedSendersAdd,
  handleDashboardShippingFactsSet,
  handleDashboardReturnsFactsSet,
  handleDashboardFactReferences,
  handleDashboardFactReferencesResolve,
  handleDashboardBlockedSendersRemove,
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
  handleDashboardResolutionPolicy,
  handleDashboardSetResolutionPolicy,
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
  handleDashboardCancellationRestock,
  handleDashboardDiscountPolicy,
  handleDashboardFulfillmentOperatorSheet,
  handleDashboardFulfillmentOperatorSheetClear,
} from "./connect-handlers.js";

export const registerDashboardRoutes = (
  app: FastifyInstance,
  ctx: RouteContext,
): void => {
  const { dashboardGet, dashboardPost } = makeDashboardRoutes(app, ctx);

  // ---- Dashboard read API ----
  dashboardGet("/dashboard/today", "Today-view rollup", handleDashboardToday, "tickets.view");
  dashboardGet(
    "/dashboard/tickets",
    "Paginated tickets list",
    handleDashboardTickets,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id",
    "Ticket detail with timeline + approvals",
    handleDashboardTicketDetail,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id/conversation-thread",
    "Live customer email thread for a ticket",
    handleDashboardTicketConversationThread,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id/events",
    "New audit events for a ticket since ?since=",
    handleDashboardTicketEvents,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id/shopify",
    "Ticket-detail Shopify customer/order panels",
    handleDashboardTicketShopify,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id/tracking",
    "Live carrier tracking for the ticket's shipment",
    handleDashboardTicketTracking,
    "tickets.view",
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
  dashboardGet("/dashboard/audit", "Cross-ticket audit log", handleDashboardAudit, "audit.view");
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
    "Resolved tenant settings (refund policy + fulfillment partner sheet)",
    handleDashboardSettings,
  );
  dashboardGet(
    "/dashboard/resolution-policy",
    "Resolution agent flag + scenario playbooks",
    handleDashboardResolutionPolicy,
    "settings.agents",
  );
  dashboardGet(
    "/dashboard/shop-currency",
    "Best-effort Shopify store currency (ISO 4217) or null",
    handleDashboardShopCurrency,
  );
  dashboardGet(
    "/dashboard/blocked-senders",
    "The tenant's sender blocklist (emails + domains)",
    handleDashboardBlockedSenders,
    "settings.blocked_senders",
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
    "/dashboard/tickets/:id/approvals/approve",
    "Approve the whole pending bundle for a ticket (manager)",
    handleDashboardTicketApprovalsBundle("approve"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/tickets/:id/approvals/reject",
    "Reject the whole pending bundle for a ticket (manager)",
    handleDashboardTicketApprovalsBundle("reject"),
    "approvals.decide",
  );
  dashboardPost(
    "/dashboard/tickets/:id/takeover",
    "Take over a ticket (manager)",
    handleDashboardTakeover,
    "tickets.takeover",
  );
  dashboardPost(
    "/dashboard/tickets/:id/resume",
    "Hand a taken-over ticket back to the agent (manager)",
    handleDashboardResume,
    "tickets.resume",
  );
  dashboardPost(
    "/dashboard/tickets/:id/status",
    "Manually set a ticket's status (manager)",
    handleDashboardSetTicketStatus,
    "tickets.set_status",
  );
  dashboardPost(
    "/dashboard/tickets/:id/resolve",
    "Resolve a ticket by hand, including one under takeover (manager)",
    handleDashboardResolveTicket,
    "tickets.set_status",
  );
  dashboardPost(
    "/dashboard/tickets/:id/details",
    "Hand-correct a ticket's customer / order the agent couldn't extract (manager)",
    handleDashboardEditTicketDetails,
    "tickets.set_status",
  );
  dashboardPost(
    "/dashboard/tickets/:id/shipping-address",
    "Fix the order's shipping address before fulfillment (manager)",
    handleDashboardEditShippingAddress,
    // A store write, not a ticket-state correction — its own grant, like
    // refunds.issue.
    "orders.edit",
  );
  dashboardPost(
    "/dashboard/tickets/:id/escalate-fulfillment-operator",
    "Escalate a ticket to the workspace's fulfillment partner by hand (manager)",
    handleDashboardEscalateFulfillmentOperator,
    "tickets.set_status",
  );
  dashboardPost(
    "/dashboard/tickets/:id/block-sender",
    "Add this ticket's customer email to the sender blocklist (manager)",
    handleDashboardBlockTicketSender,
    "settings.blocked_senders",
  );
  dashboardPost(
    "/dashboard/tickets/:id/retry",
    "Hand a taken-over ticket back and have the agent retry now (manager)",
    handleDashboardRetry,
    "tickets.retry",
  );
  dashboardPost(
    "/dashboard/tickets/:id/retry-send",
    "Re-send the drafted customer reply whose delivery failed (manager)",
    handleDashboardRetrySend,
    "tickets.retry",
  );
  dashboardPost(
    "/dashboard/tickets/:id/resend-approval",
    "Resend an approved reply that was never sent (skipped on takeover)",
    handleDashboardResendApproval,
    "tickets.retry",
  );
  dashboardPost(
    "/dashboard/tickets/:id/reply",
    "Send a human-drafted customer reply while driving a taken-over ticket",
    handleDashboardTicketReply,
    "tickets.reply",
  );
  dashboardGet(
    "/dashboard/tickets/:id/attachments",
    "The ticket's attachment index (uploads + ingested files)",
    handleDashboardTicketAttachments,
    "tickets.view",
  );
  dashboardGet(
    "/dashboard/tickets/:id/attachments/:attachmentId/url",
    "A short-lived signed URL for one of the ticket's attachments (preview)",
    handleDashboardTicketAttachmentUrl,
    "tickets.view",
  );
  dashboardPost(
    "/dashboard/tickets/:id/attachments",
    "Upload an attachment (raw bytes) to use in replies from this ticket",
    handleDashboardTicketAttachmentUpload,
    "tickets.reply",
    // Global cap is 1 MiB; attachments follow the ingestion cap (10 MiB)
    // plus headroom.
    { bodyLimit: 11 * 1024 * 1024 },
  );
  dashboardGet(
    "/dashboard/tickets/:id/refund-context",
    "Refundable line items + pricing for the ticket's order (refund modal)",
    handleDashboardRefundContext,
    "refunds.issue",
  );
  dashboardPost(
    "/dashboard/tickets/:id/refund",
    "Issue a refund on a ticket's order (manager)",
    handleDashboardIssueRefund,
    "refunds.issue",
  );
  dashboardPost(
    "/dashboard/tickets/:id/cancel-order",
    "Cancel a ticket's order, refunding and restocking it (manager)",
    handleDashboardCancelOrder,
    // A cancel refunds captured money by default — same grant as a refund,
    // not the `orders.edit` store-write grant.
    "refunds.issue",
  );
  dashboardPost(
    "/dashboard/rephrase",
    "AI-polish a reply draft (one-shot, spent against the tenant's LLM key)",
    handleDashboardRephrase,
    "tickets.reply",
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
    "/dashboard/cancellation-restock",
    "Set whether order cancellations restock inventory",
    handleDashboardCancellationRestock,
    "settings.refund_policy",
  );
  dashboardPost(
    "/dashboard/discount-policy",
    "Set the goodwill-coupon (discount) policy",
    handleDashboardDiscountPolicy,
    "settings.refund_policy",
  );
  dashboardPost(
    "/dashboard/shipping-facts",
    "Save the store's shipping facts",
    handleDashboardShippingFactsSet,
    "knowledge.manage",
  );
  // Pre-rename path (2026-07-11), kept so a dashboard build cached from before
  // the rename can still save. The SPA and the API deploy separately, so the
  // new path alone would break saves for the length of that window.
  dashboardPost(
    "/dashboard/shipping-profile",
    "Save the store's shipping facts (legacy path)",
    handleDashboardShippingFactsSet,
    "knowledge.manage",
  );
  dashboardPost(
    "/dashboard/returns-facts",
    "Save the store's returns facts",
    handleDashboardReturnsFactsSet,
    "knowledge.manage",
  );
  dashboardGet(
    "/dashboard/fact-references",
    "The @-reference catalog for the scenario-notes editor",
    handleDashboardFactReferences,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/fact-references/resolve",
    "Resolve @-references in a note against the tenant's facts",
    handleDashboardFactReferencesResolve,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/blocked-senders/add",
    "Block an email address or a whole domain",
    handleDashboardBlockedSendersAdd,
    "settings.blocked_senders",
  );
  dashboardPost(
    "/dashboard/blocked-senders/remove",
    "Unblock an email address or domain",
    handleDashboardBlockedSendersRemove,
    "settings.blocked_senders",
  );
  dashboardPost(
    "/dashboard/resolution-policy",
    "Save the resolution-agent scenario playbooks",
    handleDashboardSetResolutionPolicy,
    "settings.agents",
  );
  dashboardPost(
    "/dashboard/fulfillment-operator-sheet",
    "Set the fulfillment partner-escalation sheet",
    handleDashboardFulfillmentOperatorSheet,
    "settings.integrations",
  );
  dashboardPost(
    "/dashboard/fulfillment-operator-sheet/clear",
    "Clear the fulfillment partner-escalation sheet",
    handleDashboardFulfillmentOperatorSheetClear,
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
