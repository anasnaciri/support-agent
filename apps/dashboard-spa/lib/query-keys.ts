import type {
  ApprovalsFilter,
  AuditFilter,
  CasesFilter,
} from "@support-agent/dashboard-contracts";

// TanStack Query key factory. THE load-bearing rule: `workspaceId` is part of
// every workspace-scoped key, so switching the active workspace automatically
// stops serving another workspace's cached cases/approvals/settings. Reads →
// useQuery(qk.*); writes invalidate the matching prefixes.
export const qk = {
  authSession: ["auth-session"] as const,
  workspaces: ["workspaces"] as const, // NOT workspace-scoped
  supplierWorkspaces: ["supplier-workspaces"] as const, // identity-scoped, cross-org
  openRouterPricing: ["openrouter-pricing"] as const, // NOT workspace-scoped
  me: (w: string) => ["me", w] as const,
  supplierSession: (w: string) => ["supplier-session", w] as const,

  today: (w: string) => ["today", w] as const,
  cases: (w: string, f: CasesFilter, page: number, limit: number) =>
    ["cases", w, f, page, limit] as const,
  case: (w: string, id: string) => ["case", w, id] as const,
  caseThread: (w: string, id: string) => ["case", w, id, "thread"] as const,
  caseShopify: (w: string, id: string) => ["case", w, id, "shopify"] as const,
  caseTracking: (w: string, id: string) => ["case", w, id, "tracking"] as const,
  caseEvents: (w: string, id: string) => ["case-events", w, id] as const,

  approvals: (w: string, f: ApprovalsFilter, page: number, limit: number) =>
    ["approvals", w, f, page, limit] as const,
  approval: (w: string, id: string) => ["approval", w, id] as const,

  audit: (w: string, f: AuditFilter, page: number, limit: number) =>
    ["audit", w, f, page, limit] as const,

  catalog: (w: string) => ["catalog", w] as const,
  models: (w: string) => ["models", w] as const,
  settings: (w: string) => ["settings", w] as const,
  resolutionPolicy: (w: string) => ["resolution-policy", w] as const,
  connections: (w: string) => ["connections", w] as const,
  shopifyApp: (w: string) => ["shopify-app", w] as const,
  knowledge: (w: string) => ["knowledge", w] as const,
  knowledgeDoc: (w: string, id: string) => ["knowledge", w, id] as const,
  llm: (w: string) => ["llm", w] as const,
  usage: (w: string, start: string, end: string) =>
    ["usage", w, start, end] as const,
  agentOverrides: (w: string) => ["agent-overrides", w] as const,
  customAgent: (w: string, id: string) => ["custom-agent", w, id] as const,
  members: (w: string) => ["members", w] as const,
  roles: (w: string) => ["roles", w] as const,
  permissionCatalog: (w: string) => ["permission-catalog", w] as const,
  shopCurrency: (w: string) => ["shop-currency", w] as const,
  supplierCases: (w: string) => ["supplier-cases", w] as const,
  supplierCase: (w: string, id: string) => ["supplier-case", w, id] as const,
} as const;

/** Everything scoped to a workspace shares this prefix — invalidate on switch. */
export const workspaceScopedKeyPrefixes = [
  "me",
  "supplier-session",
  "today",
  "cases",
  "case",
  "case-events",
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
  "custom-agent",
  "members",
  "roles",
  "permission-catalog",
  "shop-currency",
  "supplier-cases",
  "supplier-case",
] as const;
