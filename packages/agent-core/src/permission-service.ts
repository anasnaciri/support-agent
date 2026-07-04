import { Context, Effect, Layer } from "effect";
import type { AgentConfig, Permission } from "./agent.js";
import type { TicketId, TenantId } from "./ids.js";
import type { AnyTool } from "./tool-registry.js";

export interface PermissionCheckInput {
  readonly tenantId: TenantId;
  readonly agent: AgentConfig;
  readonly tool: AnyTool;
  readonly payload: unknown;
  /**
   * The ticket this tool call belongs to. Optional for back-compat;
   * when present, conditional rules may consult per-ticket history —
   * e.g. the refund threshold compares the ticket-cumulative refunded
   * amount, not each call in isolation (audit L9).
   */
  readonly ticketId?: TicketId;
}

/**
 * Decides whether a tool call may run, must ask for human approval, or must
 * be denied outright. The decision is computed from layered sources:
 *
 *   1. agent.permissionOverrides[toolName]      — agent-specific override
 *   2. tool.defaultPermission                   — tool-shipped default
 *
 * Phase 4 will add tenant-level policy rules and conditional rules
 * (`{ "input.amountCents": { "lte": 2500 } }` etc.). The Tag interface stays
 * the same; the Default Layer will be swapped for a richer Live Layer that
 * also reads from PolicyService.
 *
 * Decisions are pure functions of their inputs — no I/O, no logging here.
 * Audit happens at the ToolExecutor boundary in the runtime.
 */
export class PermissionService extends Context.Tag("PermissionService")<
  PermissionService,
  {
    readonly check: (
      input: PermissionCheckInput,
    ) => Effect.Effect<Permission>;
  }
>() {}

export const PermissionServiceDefault = Layer.succeed(
  PermissionService,
  PermissionService.of({
    check: ({ agent, tool }) =>
      Effect.sync(() => {
        const override = agent.permissionOverrides[tool.name];
        return override ?? tool.defaultPermission;
      }),
  }),
);
