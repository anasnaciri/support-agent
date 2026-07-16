import type {
  ApprovalsFilter,
  AuditFilter,
  TicketsFilter,
} from "@support-agent/dashboard-contracts";

// TanStack Query key factory. THE load-bearing rule: `workspaceId` is part of
// every workspace-scoped key, so switching the active workspace automatically
// stops serving another workspace's cached tickets/approvals/settings. Reads →
// useQuery(qk.*); writes invalidate the matching prefixes.
export const qk = {
  authSession: ["auth-session"] as const,
  workspaces: ["workspaces"] as const, // NOT workspace-scoped
  fulfillmentOperatorWorkspaces: ["fulfillment-operator-workspaces"] as const, // identity-scoped, cross-org
  openRouterPricing: ["openrouter-pricing"] as const, // NOT workspace-scoped
  me: (w: string) => ["me", w] as const,
  fulfillmentOperatorSession: (w: string) => ["fulfillment-operator-session", w] as const,
  onboarding: (w: string) => ["onboarding", w] as const,

  today: (w: string) => ["today", w] as const,
  supportAnalytics: (w: string, start: string, end: string) =>
    ["support-analytics", w, start, end] as const,
  deliveryAnalytics: (w: string, start: string, end: string) =>
    ["delivery-analytics", w, start, end] as const,
  tickets: (w: string, f: TicketsFilter, page: number, limit: number) =>
    ["tickets", w, f, page, limit] as const,
  ticket: (w: string, id: string) => ["ticket", w, id] as const,
  ticketThread: (w: string, id: string) => ["ticket", w, id, "thread"] as const,
  ticketAttachments: (w: string, id: string) =>
    ["ticket", w, id, "attachments"] as const,
  ticketShopify: (w: string, id: string) => ["ticket", w, id, "shopify"] as const,
  ticketTracking: (w: string, id: string) => ["ticket", w, id, "tracking"] as const,
  ticketEvents: (w: string, id: string) => ["ticket-events", w, id] as const,

  approvals: (w: string, f: ApprovalsFilter, page: number, limit: number) =>
    ["approvals", w, f, page, limit] as const,
  approval: (w: string, id: string) => ["approval", w, id] as const,

  audit: (w: string, f: AuditFilter, page: number, limit: number) =>
    ["audit", w, f, page, limit] as const,

  catalog: (w: string) => ["catalog", w] as const,
  models: (w: string) => ["models", w] as const,
  settings: (w: string) => ["settings", w] as const,
  resolutionPolicy: (w: string) => ["resolution-policy", w] as const,
  factReferences: (w: string) => ["fact-references", w] as const,
  blockedSenders: (w: string) => ["blocked-senders", w] as const,
  connections: (w: string) => ["connections", w] as const,
  llmStatus: (w: string) => ["llm-status", w] as const,
  shopifyApp: (w: string) => ["shopify-app", w] as const,
  knowledge: (w: string) => ["knowledge", w] as const,
  knowledgeDoc: (w: string, id: string) => ["knowledge", w, id] as const,
  llm: (w: string) => ["llm", w] as const,
  usage: (w: string, start: string, end: string) =>
    ["usage", w, start, end] as const,
  agentOverrides: (w: string) => ["agent-overrides", w] as const,
  members: (w: string) => ["members", w] as const,
  roles: (w: string) => ["roles", w] as const,
  permissionCatalog: (w: string) => ["permission-catalog", w] as const,
  shopCurrency: (w: string) => ["shop-currency", w] as const,
  storeProfile: (w: string) => ["store-profile", w] as const,
  fulfillmentOperatorTickets: (w: string) => ["fulfillment-operator-tickets", w] as const,
  fulfillmentOperatorTicket: (w: string, id: string) => ["fulfillment-operator-ticket", w, id] as const,
} as const;

/** Everything scoped to a workspace shares this prefix — invalidate on switch. */
export const workspaceScopedKeyPrefixes = [
  "me",
  "fulfillment-operator-session",
  "today",
  "support-analytics",
  "delivery-analytics",
  "tickets",
  "ticket",
  "ticket-events",
  "approvals",
  "approval",
  "audit",
  "catalog",
  "models",
  "settings",
  "resolution-policy",
  "connections",
  "shopify-app",
  "knowledge",
  "llm",
  "usage",
  "agent-overrides",
  "members",
  "roles",
  "permission-catalog",
  "shop-currency",
  "fulfillment-operator-tickets",
  "fulfillment-operator-ticket",
] as const;
