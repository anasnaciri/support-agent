import { Effect, Layer, Option } from "effect";
import {
  PermissionService,
  type CaseId,
  type Permission,
  type AnyTool,
  type TenantId,
} from "@support-agent/agent-core";
import {
  TenantRepository,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  type RefundPolicy,
  type DiscountPolicy,
} from "./tenant-repository.js";
import {
  ConnectorCredentialStore,
  type ConnectorConnection,
} from "./connector-credential-store.js";
import { AuditLogService } from "./audit-log.js";
import { isConnectorScopeGranted } from "@support-agent/dashboard-contracts";

// Re-exported for back-compat: the canonical implementation now lives in
// `@support-agent/dashboard-contracts` so the dashboard's integrations grid
// and this runtime precheck share one rule. See its doc comment.
export { isConnectorScopeGranted };

/**
 * Live `PermissionService` that layers per-tenant conditional rules on
 * top of the static (agent-override → tool-default) decision in the
 * Default layer.
 *
 * Today the only conditional rule is for `refund.create`: the tool's
 * `defaultPermission` is `ask`, and the tenant's `refundPolicy`
 * thresholds further split that into `allow` (below `askAbove`) or
 * `deny` (above `denyAbove`). Everything else falls through to the
 * static decision.
 *
 * The conditional rule applies AFTER the static decision so it can
 * only LOWER the permission level (from ask → allow for safe small
 * refunds) or RAISE it (from ask → deny for refunds that exceed the
 * hard cap). It never elevates a tool's static decision past the
 * tenant's hard cap.
 *
 * Decision pipeline (master-plan §9):
 *   1. agent.permissionOverrides[tool] ?? tool.defaultPermission   (static)
 *   2. apply tenant-level conditional rules                        (this layer)
 *   3. return Permission
 *
 * Live impl lives in `packages/services` rather than `packages/db`
 * because the only external Tag it depends on is TenantRepository
 * (another services Tag). The DB hop is satisfied by whoever provides
 * `TenantRepositoryLive` (= `packages/db`) — this layer stays
 * provider-neutral.
 */
const REFUND_TOOL = "refund.create";
const DISCOUNT_TOOL = "discount.create";
// `order.cancel` cancels an order AND refunds it, so it's gated by the same
// per-tenant refund policy as `refund.create` (mode + amount thresholds). Its
// payload carries the order's refundable total under the same `amount` shape,
// so `parseRefundAmount` reads it directly.
const CANCEL_TOOL = "order.cancel";

/**
 * Parse `amount` from a `refund.create` payload into minor units
 * (cents, pence, …). Returns null when the payload doesn't match the
 * expected shape — defensive against malformed LLM output. The minor-
 * units conversion uses `Math.round` on `amount * 100` which is the
 * standard pattern for 2-decimal currencies; non-2-decimal currencies
 * (JPY, KRW) would skew slightly but we don't yet declare per-currency
 * exponents.
 */
export const parseRefundAmount = (
  payload: unknown,
): { amountMinorUnits: number; currencyCode: string } | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const amt = p["amount"];
  if (!amt || typeof amt !== "object") return null;
  const a = amt as Record<string, unknown>;
  const value = a["amount"];
  const ccy = a["currencyCode"];
  if (typeof value !== "string" || typeof ccy !== "string") return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return {
    amountMinorUnits: Math.round(parsed * 100),
    currencyCode: ccy.toUpperCase(),
  };
};

/**
 * Apply the refund-policy decision to an already-statically-decided
 * permission. Pure — exported so it can be unit-tested without an
 * Effect runtime. The static permission is the input; the output may
 * be the same value or upgraded (ask → allow) / downgraded (ask → deny).
 */
export const applyRefundPolicy = (
  staticPermission: Permission,
  policy: RefundPolicy,
  amount: { amountMinorUnits: number; currencyCode: string } | null,
): Permission => {
  // Mode sits above the amount zones.
  const mode = policy.mode ?? "thresholds";
  // Hard kill-switch — deny every refund, no matter the amount, currency,
  // or static decision. Can't be relaxed.
  if (mode === "always_deny") return "deny";
  // Every refund waits for a human, regardless of amount. Never auto-allow;
  // never relax an existing `deny`.
  if (mode === "always_ask") return staticPermission === "deny" ? "deny" : "ask";

  // Malformed payload: stay at the static decision. The tool's input
  // schema will reject the call anyway, but if it somehow slipped
  // through (e.g. raw permission check on unparsed input), be safe.
  if (!amount) return staticPermission;

  // Currency mismatch: tenant only declared a policy for their own
  // currency. We can't compare cleanly — fall back to `ask` so a
  // human reviews the cross-currency refund. Never auto-allow.
  if (amount.currencyCode !== policy.currencyCode.toUpperCase()) {
    return staticPermission === "deny" ? "deny" : "ask";
  }

  // Above the hard cap → deny, regardless of the static decision.
  if (amount.amountMinorUnits > policy.denyAboveMinorUnits) {
    return "deny";
  }

  // Below or at the ask-threshold → take the looser of (allow, static).
  // We only soften the static decision when it was already `ask`; if
  // the agent or tool wanted `deny`, we don't override it.
  if (amount.amountMinorUnits <= policy.askAboveMinorUnits) {
    return staticPermission === "ask" ? "allow" : staticPermission;
  }

  // Between thresholds → ask. If the static decision was `deny` we
  // keep `deny` (we never relax `deny`); otherwise `ask`.
  return staticPermission === "deny" ? "deny" : "ask";
};

/**
 * A discount value the agent proposed, normalized for policy comparison.
 * Percentage discounts carry a `percentage` (10 ⇒ 10%); fixed-amount
 * discounts carry minor units + currency (mirrors the refund shape).
 */
export type DiscountProposal =
  | { readonly type: "percentage"; readonly percentage: number }
  | {
      readonly type: "fixed_amount";
      readonly amountMinorUnits: number;
      readonly currencyCode: string;
    };

/**
 * Parse `valueType` + `value` (+ `currencyCode` for fixed amounts) from a
 * `discount.create` payload. Returns null when the payload doesn't match
 * the expected shape — defensive against malformed LLM output (the tool's
 * input schema will reject the call anyway, but the permission check runs
 * on the raw payload). A non-positive or non-finite value is rejected.
 */
export const parseDiscountProposal = (
  payload: unknown,
): DiscountProposal | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const valueType = p["valueType"];
  const value = p["value"];
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (valueType === "percentage") {
    return { type: "percentage", percentage: parsed };
  }
  if (valueType === "fixed_amount") {
    const ccy = p["currencyCode"];
    if (typeof ccy !== "string" || ccy.length === 0) return null;
    return {
      type: "fixed_amount",
      amountMinorUnits: Math.round(parsed * 100),
      currencyCode: ccy.toUpperCase(),
    };
  }
  return null;
};

/**
 * Apply the discount-policy decision to an already-statically-decided
 * permission. Pure — exported for unit testing without an Effect runtime.
 * Same shape as {@link applyRefundPolicy}: the policy can only soften
 * (ask → allow for small discounts) or harden (ask → deny over the cap)
 * the static decision; it never relaxes a `deny`. Percentage and
 * fixed-amount proposals gate on their respective zones; a fixed-amount
 * currency mismatch falls back to `ask` (we can't compare cleanly).
 */
export const applyDiscountPolicy = (
  staticPermission: Permission,
  policy: DiscountPolicy,
  proposal: DiscountProposal | null,
): Permission => {
  const mode = policy.mode ?? "thresholds";
  if (mode === "always_deny") return "deny";
  if (mode === "always_ask")
    return staticPermission === "deny" ? "deny" : "ask";

  // Malformed payload: stay at the static decision (the tool's input
  // schema rejects the call anyway).
  if (!proposal) return staticPermission;

  if (proposal.type === "percentage") {
    if (proposal.percentage > policy.maxPercentage) return "deny";
    if (proposal.percentage <= policy.askAbovePercentage) {
      return staticPermission === "ask" ? "allow" : staticPermission;
    }
    return staticPermission === "deny" ? "deny" : "ask";
  }

  // fixed_amount: currency mismatch → ask (never auto-allow), same as refunds.
  if (proposal.currencyCode !== policy.currencyCode.toUpperCase()) {
    return staticPermission === "deny" ? "deny" : "ask";
  }
  if (proposal.amountMinorUnits > policy.maxFixedAmountMinorUnits) {
    return "deny";
  }
  if (proposal.amountMinorUnits <= policy.askAboveFixedAmountMinorUnits) {
    return staticPermission === "ask" ? "allow" : staticPermission;
  }
  return staticPermission === "deny" ? "deny" : "ask";
};

/**
 * Connector scope precheck. When a tool declares
 * `requiredConnectorScopes`, the active connection for that provider
 * MUST carry every listed scope or we deny — better to surface the
 * missing scope as a permission denial than to fire the API call and
 * crash on a 401/403 from the provider. The check looks for ANY active
 * connection on the named provider (Shopify can have multiple shops
 * per tenant in theory; today we treat the first active one as
 * authoritative). A revoked / missing connection ⇒ deny.
 *
 * Pure helper — exported so it can be unit-tested without a runtime.
 * Applies `isConnectorScopeGranted` so provider-specific hierarchies
 * (e.g. Shopify's `write_X` covers `read_X`) are honored.
 */
export const checkRequiredScopes = (
  tool: AnyTool,
  connections: ReadonlyArray<ConnectorConnection>,
): "ok" | "missing" => {
  const req = tool.requiredConnectorScopes;
  if (!req) return "ok";
  const active = connections.find(
    (c) => c.provider === req.provider && c.status === "active",
  );
  if (!active) return "missing";
  for (const s of req.scopes) {
    if (!isConnectorScopeGranted(req.provider, s, active.scopes))
      return "missing";
  }
  return "ok";
};

/**
 * Sum prior successful refund amounts for a case from its audit rows
 * (audit L9). The runtime stamps `amountMinorUnits`/`currencyCode` into
 * the `tool.invoked` details for refund.create. Returns null when any
 * prior refund is in a different currency (can't sum safely — caller
 * falls back to `ask`).
 */
export const sumPriorRefundsMinorUnits = (
  rows: ReadonlyArray<{
    readonly action: string;
    readonly details: unknown;
  }>,
  currencyCode: string,
): number | null => {
  let sum = 0;
  for (const row of rows) {
    if (row.action !== "tool.invoked") continue;
    const d = row.details as Record<string, unknown> | null;
    if (!d || d["tool"] !== REFUND_TOOL || d["ok"] !== true) continue;
    const minor = d["amountMinorUnits"];
    const ccy = d["currencyCode"];
    if (typeof minor !== "number" || typeof ccy !== "string") continue;
    if (ccy.toUpperCase() !== currencyCode.toUpperCase()) return null;
    sum += minor;
  }
  return sum;
};

export const PermissionServiceLive = Layer.effect(
  PermissionService,
  Effect.gen(function* () {
    const tenants = yield* TenantRepository;
    const connectors = yield* ConnectorCredentialStore;
    // Optional — present in the worker (and in tests that exercise the
    // aggregation); absent layers simply skip case-history aggregation
    // rather than failing every permission check.
    const maybeAudit = yield* Effect.serviceOption(AuditLogService);

    // Defensive read of all active connections for a tenant. DB errors
    // collapse to an empty list — any tool with declared scopes will
    // then fail the check and deny, which is the safer fallback (no
    // tool runs against a connector we can't verify).
    const loadConnections = (
      tenantId: TenantId,
    ): Effect.Effect<ReadonlyArray<ConnectorConnection>> =>
      connectors
        .listForTenant(tenantId)
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ConnectorConnection>)));

    // Case-cumulative refund total (audit L9): read the case's audit
    // rows and sum prior successful refund.create amounts. Best-effort —
    // audit unavailability degrades to per-call evaluation, never to a
    // failed check.
    const priorRefundTotal = (
      caseId: CaseId | undefined,
      currencyCode: string,
    ): Effect.Effect<number | null> =>
      caseId !== undefined && Option.isSome(maybeAudit)
        ? maybeAudit.value.forCase(caseId).pipe(
            Effect.map((rows) =>
              sumPriorRefundsMinorUnits(rows, currencyCode),
            ),
            Effect.catchAll(() => Effect.succeed(0)),
          )
        : Effect.succeed(0);

    return PermissionService.of({
      check: ({ tenantId, agent, tool, payload, caseId }) =>
        Effect.gen(function* () {
          // Step 1: static rule.
          const override = agent.permissionOverrides[tool.name];
          const staticPermission: Permission = override ?? tool.defaultPermission;

          // Step 2: connector scope precheck. Runs for every tool that
          // declares `requiredConnectorScopes` — today that's just
          // refund.create (`write_orders`). When the merchant hasn't
          // granted the scope, we deny outright; the agent's fallback
          // path (e.g. refund-review-agent → PATH B draft a reply)
          // picks up the structured denial.
          if (tool.requiredConnectorScopes) {
            const conns = yield* loadConnections(tenantId);
            if (checkRequiredScopes(tool, conns) === "missing") {
              return "deny";
            }
          }

          // Step 3a: conditional discount-policy decision. Like the
          // refund branch below, this overlays per-tenant thresholds on
          // top of the tool's static `ask`. Gated per-call (no case-
          // cumulative aggregation yet — coupons are single-use and
          // locked to one customer, so the per-call cap bounds exposure).
          if (tool.name === DISCOUNT_TOOL) {
            const settings = yield* tenants.getSettings(tenantId).pipe(
              Effect.catchAll(() =>
                Effect.succeed({
                  discountPolicy: defaultDiscountPolicy,
                } as const),
              ),
            );
            return applyDiscountPolicy(
              staticPermission,
              settings.discountPolicy,
              parseDiscountProposal(payload),
            );
          }

          // Step 3b: conditional refund-amount threshold. Applies to BOTH
          // `refund.create` and `order.cancel` (the cancel issues a refund, so
          // the merchant's refund policy gates it the same way). Other tools
          // short-circuit here so we don't pay the tenant-settings DB hop on
          // every permission check.
          if (tool.name !== REFUND_TOOL && tool.name !== CANCEL_TOOL)
            return staticPermission;

          // Read the tenant's refund policy. On DB failure (which
          // SHOULD be rare and indicates infra is broken) we
          // defensively fall back to the conservative default —
          // `askAbove=0` means every refund needs approval, which is
          // safer than silently allowing.
          const settings = yield* tenants.getSettings(tenantId).pipe(
            Effect.catchAll(() =>
              Effect.succeed({
                notificationEmail: null,
                refundPolicy: defaultRefundPolicy,
              } as const),
            ),
          );

          const amount = parseRefundAmount(payload);

          // Audit L9: evaluate the policy against the case-cumulative
          // refunded amount, not this call in isolation — otherwise N
          // small refunds walk past the cap one step at a time. A null
          // prior total means mixed currencies in the history: we can't
          // sum safely, so a human reviews (never auto-allow).
          if (amount && caseId !== undefined) {
            const prior = yield* priorRefundTotal(
              caseId,
              amount.currencyCode,
            );
            if (prior === null) {
              return staticPermission === "deny" ? "deny" : "ask";
            }
            if (prior > 0) {
              return applyRefundPolicy(
                staticPermission,
                settings.refundPolicy,
                {
                  amountMinorUnits: amount.amountMinorUnits + prior,
                  currencyCode: amount.currencyCode,
                },
              );
            }
          }

          return applyRefundPolicy(
            staticPermission,
            settings.refundPolicy,
            amount,
          );
        }),
    });
  }),
);
