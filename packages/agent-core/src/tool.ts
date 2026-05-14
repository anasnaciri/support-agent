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
  readonly execute: (
    input: I,
    ctx: ToolContext,
  ) => Effect.Effect<O, ToolError, ToolDeps>;
}
