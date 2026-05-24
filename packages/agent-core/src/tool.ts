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

export interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Schema<I>;
  readonly outputSchema: Schema.Schema<O>;
  readonly risk: ToolRisk;
  readonly defaultPermission: Permission;
  readonly sideEffectClass: ToolSideEffectClass;
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
