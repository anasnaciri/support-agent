// Human member RBAC — the "buildable" permission catalog.
//
// This is a CODE registry of the granular capabilities a merchant can grant to
// a teammate. Roles (merchant-editable rows in the db) reference these ids;
// adding a new capability = add one entry here + require it on the endpoint(s)
// that perform the action. The catalog is the single source of truth shared by
// the api (enforcement) and the dashboard (role editor + nav gating), so it
// lives in this Worker-safe contracts package.
//
// This is deliberately SEPARATE from the agent's tool-call `Permission`
// (`allow | ask | deny`, from agent-core) — that gates the AI; this gates
// humans. Do not conflate them.

export type RbacPermissionId =
  | "tickets.view"
  | "tickets.reply"
  | "tickets.takeover"
  | "tickets.resume"
  | "tickets.retry"
  | "tickets.set_status"
  | "orders.edit"
  | "approvals.view"
  | "approvals.decide"
  | "refunds.issue"
  | "knowledge.view"
  | "knowledge.manage"
  | "settings.agents"
  | "settings.integrations"
  | "settings.llm"
  | "settings.refund_policy"
  | "settings.blocked_senders"
  | "settings.notifications"
  | "audit.view"
  | "members.manage"
  | "account.manage"
  // Supplier portal — the heavily-constrained external role. A supplier sees
  // ONLY tickets escalated to them and can ONLY post a supplier update. Kept
  // separate from every merchant `tickets.*` permission so a Supplier role grants
  // no merchant surface (and the api gates supplier endpoints on these alone).
  | "supplier.tickets.view"
  | "supplier.tickets.respond";

export type RbacPermissionCategory =
  | "Tickets"
  | "Approvals"
  | "Knowledge"
  | "Settings"
  | "Members"
  | "Audit"
  | "Supplier";

export interface RbacPermissionDef {
  readonly id: RbacPermissionId;
  /** Merchant-facing name shown in the role editor. */
  readonly label: string;
  readonly description: string;
  readonly category: RbacPermissionCategory;
  /**
   * Permissions this one also grants. Granting `tickets.reply` should also let
   * the member SEE tickets, so `tickets.reply.implies = ["tickets.view"]`. The
   * resolver walks this transitively. Kept minimal and explicit — money/
   * decision permissions (`refunds.issue`) deliberately do NOT imply the
   * broader decision permission, so a role must grant both.
   */
  readonly implies?: ReadonlyArray<RbacPermissionId>;
}

export const RBAC_PERMISSIONS: ReadonlyArray<RbacPermissionDef> = [
  // ---- Tickets ----
  {
    id: "tickets.view",
    label: "View tickets",
    description: "See the ticket list, ticket details, and conversation threads.",
    category: "Tickets",
  },
  {
    id: "tickets.reply",
    label: "Reply to tickets",
    description: "Send replies and work a ticket's conversation.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  {
    id: "tickets.takeover",
    label: "Take over tickets",
    description: "Pause the agent and take manual control of a ticket.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  {
    id: "tickets.resume",
    label: "Hand tickets back to the agent",
    description: "Release a ticket you took over back to the agent.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  {
    id: "tickets.retry",
    label: "Retry the agent now",
    description: "Resume a ticket and have the agent re-try immediately.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  {
    id: "tickets.set_status",
    label: "Change ticket status",
    description:
      "Manually set a ticket's status — e.g. mark it resolved, reopen it, or park it waiting on the customer.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  {
    id: "orders.edit",
    label: "Edit order details",
    description:
      "Change an order's details in your store from a ticket — currently the shipping address.",
    category: "Tickets",
    implies: ["tickets.view"],
  },
  // ---- Approvals ----
  {
    id: "approvals.view",
    label: "View approvals",
    description: "See pending approvals and their reasoning.",
    category: "Approvals",
  },
  {
    id: "approvals.decide",
    label: "Approve or reject",
    description: "Approve or reject the agent's gated actions.",
    category: "Approvals",
    implies: ["approvals.view"],
  },
  {
    id: "refunds.issue",
    label: "Issue refunds",
    description:
      "Issue refunds — both approving a refund the agent proposed (required in addition to “Approve or reject”) and issuing a refund the agent only recommended, directly from the ticket.",
    category: "Approvals",
  },
  // ---- Knowledge ----
  {
    id: "knowledge.view",
    label: "View knowledge base",
    description: "Read the workspace's policy and reference documents.",
    category: "Knowledge",
  },
  {
    id: "knowledge.manage",
    label: "Manage knowledge base",
    description: "Add, edit, and remove knowledge base documents.",
    category: "Knowledge",
    implies: ["knowledge.view"],
  },
  // ---- Settings ----
  {
    id: "settings.agents",
    label: "Configure agents",
    description: "Change agent models, prompts, and action permissions.",
    category: "Settings",
  },
  {
    id: "settings.integrations",
    label: "Manage integrations",
    description: "Connect or disconnect mailboxes, Shopify, and other tools.",
    category: "Settings",
  },
  {
    id: "settings.llm",
    label: "Manage AI provider",
    description: "Set or revoke the workspace's AI provider credential.",
    category: "Settings",
  },
  {
    id: "settings.refund_policy",
    label: "Edit refund policy",
    description: "Change refund thresholds and the refund policy mode.",
    category: "Settings",
  },
  {
    id: "settings.blocked_senders",
    label: "Manage blocked senders",
    description:
      "Block email addresses or domains so their messages never open tickets.",
    category: "Settings",
  },
  {
    id: "settings.notifications",
    label: "Manage notifications",
    description: "Set up where the workspace gets alerts.",
    category: "Settings",
  },
  {
    id: "account.manage",
    label: "Manage account & workspaces",
    description:
      "Create, rename, or delete workspaces and manage account-level settings.",
    category: "Settings",
  },
  // ---- Audit ----
  {
    id: "audit.view",
    label: "View audit log",
    description: "See the full activity log of everything that happened.",
    category: "Audit",
  },
  // ---- Members ----
  {
    id: "members.manage",
    label: "Manage members & roles",
    description: "Invite teammates, assign roles, and edit role permissions.",
    category: "Members",
  },
  // ---- Supplier ----
  {
    id: "supplier.tickets.view",
    label: "View escalated tickets",
    description: "See the tickets a merchant has escalated to this supplier.",
    category: "Supplier",
  },
  {
    id: "supplier.tickets.respond",
    label: "Respond to escalated tickets",
    description:
      "Post an update or resolution on a ticket escalated to this supplier.",
    category: "Supplier",
    implies: ["supplier.tickets.view"],
  },
];

export const RBAC_PERMISSION_IDS: ReadonlySet<RbacPermissionId> = new Set(
  RBAC_PERMISSIONS.map((p) => p.id),
);

export const isRbacPermissionId = (
  value: string,
): value is RbacPermissionId =>
  (RBAC_PERMISSION_IDS as ReadonlySet<string>).has(value);
