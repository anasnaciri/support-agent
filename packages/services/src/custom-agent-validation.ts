import { isConnectorScopeGranted } from "@support-agent/dashboard-contracts";
import type {
  CustomAgentErrorCode,
  CustomAgentStatus,
} from "@support-agent/dashboard-contracts";
import type { ToolConnectorScopeRequirement } from "@support-agent/agent-core";
import type { CustomAgentInput } from "./custom-agent-service.js";

// Pure save-time validation for a merchant-authored agent. Lives in services so
// it's unit-testable without a DB and reusable by the API handler, which
// assembles `ctx` from ALL_TOOLS, the tenant's connector scopes, and the known
// agent ids. The runtime PermissionService deny remains the BACKSTOP: a scope
// revoked AFTER save still fails safe at execution, exactly as for built-ins.

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 280;
export const INSTRUCTIONS_MAX = 20_000;

const VALID_STATUSES: ReadonlySet<CustomAgentStatus> = new Set([
  "draft",
  "active",
  "disabled",
]);

export interface CustomAgentValidationContext {
  // Tool names a merchant may assign (ALL_TOOLS minus internal/plumbing).
  readonly assignableToolNames: ReadonlySet<string>;
  // Every agent id a handoff/callableFrom target may reference (built-ins +
  // this tenant's custom agents). Excludes the agent being edited (self).
  readonly knownAgentIds: ReadonlySet<string>;
  // The id of the agent being edited (update) so a self-handoff is rejected;
  // null on create.
  readonly selfAgentId: string | null;
  // Active connector scopes the tenant has, by provider (e.g. shopify →
  // {write_orders}). Used to verify scope-gated tools are satisfiable.
  readonly grantedScopesByProvider: ReadonlyMap<string, ReadonlyArray<string>>;
  // requiredConnectorScopes by tool name, for the assignable tools.
  readonly toolScopeReqs: ReadonlyMap<string, ToolConnectorScopeRequirement>;
}

export interface CustomAgentValidationFailure {
  readonly ok: false;
  readonly error: CustomAgentErrorCode;
  // Optional human-pointer detail (a tool name, a provider+scope) for the
  // dashboard to render a precise message.
  readonly detail?: string;
}

export type CustomAgentValidationResult =
  | { readonly ok: true }
  | CustomAgentValidationFailure;

const fail = (
  error: CustomAgentErrorCode,
  detail?: string,
): CustomAgentValidationFailure =>
  detail === undefined ? { ok: false, error } : { ok: false, error, detail };

export const validateCustomAgentInput = (
  input: CustomAgentInput,
  ctx: CustomAgentValidationContext,
): CustomAgentValidationResult => {
  const name = input.name.trim();
  if (name.length === 0) return fail("name_required");
  if (name.length > NAME_MAX) return fail("name_too_long");

  if (input.description.trim().length === 0) return fail("description_required");
  if (input.description.length > DESCRIPTION_MAX)
    return fail("description_too_long");

  if (input.instructions.trim().length === 0)
    return fail("instructions_required");
  if (input.instructions.length > INSTRUCTIONS_MAX)
    return fail("instructions_too_long");

  if (input.model.trim().length === 0) return fail("model_required");

  if (!VALID_STATUSES.has(input.status)) return fail("invalid_status");

  // Tools: each must be assignable; agent.handoff is implicit, never assigned.
  for (const tool of input.tools) {
    if (!ctx.assignableToolNames.has(tool)) return fail("invalid_tool", tool);
  }

  // Scope safety: every assigned tool with a connector-scope requirement must
  // be satisfiable by the tenant's current grants.
  for (const tool of input.tools) {
    const req = ctx.toolScopeReqs.get(tool);
    if (!req) continue;
    const granted = ctx.grantedScopesByProvider.get(req.provider) ?? [];
    for (const scope of req.scopes) {
      if (!isConnectorScopeGranted(req.provider, scope, granted)) {
        return fail("missing_connector_scope", `${tool}:${req.provider}:${scope}`);
      }
    }
  }

  // Handoffs: each target known + not self.
  for (const target of input.handoffs) {
    if (ctx.selfAgentId !== null && target === ctx.selfAgentId)
      return fail("self_handoff", target);
    if (!ctx.knownAgentIds.has(target)) return fail("invalid_handoff", target);
  }

  // callableFrom: each must be a known agent id.
  for (const source of input.callableFrom) {
    if (!ctx.knownAgentIds.has(source))
      return fail("invalid_callable_from", source);
  }

  // permissionOverrides: keys ⊆ assigned tools; values ∈ {ask, allow} (a
  // merchant never sets deny — withholding the tool is how they deny it).
  for (const [tool, permission] of Object.entries(input.permissionOverrides)) {
    if (!input.tools.includes(tool)) return fail("invalid_permission", tool);
    if (permission !== "ask" && permission !== "allow")
      return fail("invalid_permission", tool);
  }

  return { ok: true };
};
