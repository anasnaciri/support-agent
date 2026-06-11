import type { Duration, Effect, Schedule, Schema } from "effect";
import type { AgentId, CaseId, TenantId } from "./ids.js";
import type { Permission } from "./agent.js";
import type { ToolError } from "./errors.js";

export type ToolRisk = "read" | "write" | "communicate" | "money";

export type ToolSideEffectClass =
  | "none"
  | "external_message"
  | "external_state"
  | "financial";

export interface ToolContext {
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  /** Exact conversation mailbox for tools acting on a case thread. */
  readonly mailbox?: string;
  readonly agentId: AgentId;
  readonly callId: string;
  readonly attemptNumber: number;
}

export type ToolDeps = unknown;

/**
 * Connector access scopes the tool needs the merchant to have granted
 * for its underlying provider API to work. Today only used for Shopify
 * (`refund.create` needs `write_orders`); the runtime's
 * `PermissionService` short-circuits to `deny` when any declared scope
 * isn't in the active connection's granted set — better to surface the
 * miss as a permission denial than to fire the API call and crash on a
 * 401/403 mid-flight.
 *
 * `provider` is a plain string instead of the tighter union from
 * `@support-agent/services` (`ConnectorProvider`) to keep `agent-core`
 * free of cross-package deps (CLAUDE.md invariant). The provider is
 * matched against the connector store's `provider` column verbatim, so
 * spelling matters — use lowercase `"shopify"` / `"gmail"` / etc.
 */
export interface ToolConnectorScopeRequirement {
  readonly provider: string;
  readonly scopes: ReadonlyArray<string>;
}

/**
 * How a tenant gets to configure this tool from the dashboard. Tools WITHOUT
 * a `tenantControl` are internal plumbing (lookups, handoff, case bookkeeping)
 * and never surface on the tenant-facing agent page. The value picks the
 * control:
 *   - `permission-toggle` — a simple "ask first" vs "auto" switch backed by a
 *     per-agent permission override (e.g. send a customer reply).
 *   - `refund-threshold` — governed by the richer $-amount thresholds on the
 *     dedicated refund-policy page, not a binary toggle. The agent page shows
 *     it read-only with a link.
 */
export type TenantToolControl = "permission-toggle" | "refund-threshold";

export interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Schema<I>;
  readonly outputSchema: Schema.Schema<O>;
  readonly risk: ToolRisk;
  readonly defaultPermission: Permission;
  readonly sideEffectClass: ToolSideEffectClass;
  /**
   * Friendly, tenant-facing label for the dashboard (e.g. "Send customer
   * reply"). `description` stays LLM-facing/technical; this is the human copy.
   * Only set on tools that carry a `tenantControl`.
   */
  readonly displayName?: string;
  /**
   * Short, plain-language blurb shown under the `displayName` on the agent
   * page. Distinct from the LLM-facing `description`.
   */
  readonly displayDescription?: string;
  /**
   * Marks a tool as tenant-configurable and picks its dashboard control.
   * Absent ⇒ internal ⇒ hidden from the tenant agent page. See
   * {@link TenantToolControl}.
   */
  readonly tenantControl?: TenantToolControl;
  readonly idempotencyKey?: (input: I) => string;
  readonly timeout?: Duration.Duration;
  readonly retrySchedule?: Schedule.Schedule<unknown, unknown>;
  /**
   * Optional connector scope requirements. When set, `PermissionService`
   * denies the call before execute if the active connection doesn't
   * carry every listed scope. Reach for this on tools that hit a
   * scoped provider API — the agent then sees a structured denial and
   * can route to a fallback path (e.g. refund-review-agent switches to
   * drafting a reply when `refund.create` is denied for missing scope).
   */
  readonly requiredConnectorScopes?: ToolConnectorScopeRequirement;
  readonly execute: (
    input: I,
    ctx: ToolContext,
  ) => Effect.Effect<O, ToolError, ToolDeps>;
}
