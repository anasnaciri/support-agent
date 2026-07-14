import { Effect } from "effect";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  TenantRepository,
  advanceOnboardingState,
  isOnboardingStepKey,
  onboardingPending,
  type OnboardingState,
  type OnboardingStepKey,
  type OnboardingStepStatus,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import type { OnboardingStateView } from "@support-agent/dashboard-contracts";
import { authenticateDashboard } from "../../auth/dashboard-context.js";
import { parseJsonBody, sendJson } from "../../platform/http.js";
import { type ApiConfig, type ApiLayer } from "../../bootstrap.js";

/**
 * The setup wizard's own endpoints. They are membership-gated but carry NO
 * settings permission: they move a bookmark, they don't configure anything.
 * Each step's real save goes through that feature's existing (permission-gated)
 * endpoint, so a member without, say, `settings.llm` can walk the wizard and
 * still be refused the write.
 */

const view = (state: OnboardingState | null): OnboardingStateView => ({
  pending: onboardingPending(state),
  steps: state?.steps ?? {},
  currentStep: state?.currentStep ?? null,
  completedAt: state?.completedAt ?? null,
  dismissedAt: state?.dismissedAt ?? null,
});

const readState = (layer: ApiLayer, tenantId: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(tenantId));
        return settings.onboarding ?? null;
      }),
      layer,
    ),
  );

const writeState = (layer: ApiLayer, tenantId: string, state: OnboardingState) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setOnboardingState(TenantId(tenantId), state);
      }),
      layer,
    ),
  );

// GET /dashboard/onboarding/state
export const handleDashboardOnboardingState = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
  return sendJson(res, 200, view(await readState(layer, auth.tenantId)));
};

// POST /dashboard/onboarding/advance — record a step outcome and/or move the
// resume pointer. The pointer-only form is what the wizard writes just before
// a connector OAuth redirect leaves the SPA.
export const handleDashboardOnboardingAdvance = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

  const body = parseJsonBody(req);
  const rawStep = body["step"];
  const rawStatus = body["status"];
  const rawNext = body["nextStep"];

  if (rawStep !== undefined && !isOnboardingStepKey(rawStep)) {
    return sendJson(res, 400, { error: "invalid_step" });
  }
  if (
    rawStatus !== undefined &&
    rawStatus !== "done" &&
    rawStatus !== "skipped"
  ) {
    return sendJson(res, 400, { error: "invalid_status" });
  }
  if (rawNext !== undefined && !isOnboardingStepKey(rawNext)) {
    return sendJson(res, 400, { error: "invalid_next_step" });
  }

  const current = await readState(layer, auth.tenantId);
  // An unstamped workspace (one that predates the wizard) has no state to
  // advance. Writing one here would gate an established merchant into the
  // wizard on a stray call, so the advance is a no-op instead.
  if (current === null) return sendJson(res, 200, view(null));

  const next = advanceOnboardingState(current, {
    ...(rawStep !== undefined ? { step: rawStep as OnboardingStepKey } : {}),
    ...(rawStatus !== undefined
      ? { status: rawStatus as OnboardingStepStatus }
      : {}),
    ...(rawNext !== undefined ? { nextStep: rawNext as OnboardingStepKey } : {}),
  });
  await writeState(layer, auth.tenantId, next);
  return sendJson(res, 200, view(next));
};

/** Shared by dismiss ("Set up later") and complete — both end the wizard. */
const finishOnboarding = async (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
  field: "completedAt" | "dismissedAt",
): Promise<FastifyReply> => {
  const auth = await authenticateDashboard(cfg, layer, req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

  const current = await readState(layer, auth.tenantId);
  if (current === null) return sendJson(res, 200, view(null));
  // Idempotent: a double-click (or a retry) keeps the first timestamp rather
  // than moving it.
  if (!onboardingPending(current)) return sendJson(res, 200, view(current));

  const next: OnboardingState = {
    ...current,
    [field]: new Date().toISOString(),
  };
  await writeState(layer, auth.tenantId, next);
  return sendJson(res, 200, view(next));
};

// POST /dashboard/onboarding/dismiss
export const handleDashboardOnboardingDismiss = (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> =>
  finishOnboarding(cfg, layer, req, res, "dismissedAt");

// POST /dashboard/onboarding/complete
export const handleDashboardOnboardingComplete = (
  cfg: ApiConfig,
  layer: ApiLayer,
  req: FastifyRequest,
  res: FastifyReply,
): Promise<FastifyReply> =>
  finishOnboarding(cfg, layer, req, res, "completedAt");
