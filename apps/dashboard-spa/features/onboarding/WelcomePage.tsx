import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
import type { OnboardingStepKeyView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { useAppNavigate } from "@/lib/navigation";
import { WIZARD_STEPS, resumeStepFor } from "@/lib/setup-wizard-gate";
import { Button } from "@/components/ui/button";
import { WIZARD_STEP_DEFS, stepDefFor, stepIndex } from "./steps";
import { WizardStepper } from "./WizardStepper";
import { SetupWarnings } from "./SetupWarnings";

// The post-sign-up setup wizard. Full screen, authed but outside the dashboard
// shell: this is the one place a merchant configures the whole workspace in
// order, and the nav rail beside it would just be a set of ways to lose the
// thread.
//
// Progress is persisted per workspace (POST /dashboard/onboarding/advance), so
// this survives a reload, a connector OAuth round-trip out of the SPA, and the
// next login. Every step saves through the same endpoint its settings page uses
// — the wizard sequences the existing features, it does not fork them.

export function WelcomePage() {
  const ctx = useWorkspaceCtx();
  const session = useSession();
  const qc = useQueryClient();
  const nav = useAppNavigate();

  const stateQuery = useQuery({
    queryKey: qk.onboarding(ctx.workspaceId),
    queryFn: () => api.onboardingState(ctx),
  });

  const [step, setStep] = useState<OnboardingStepKeyView | null>(null);

  // Open on the persisted resume point, once, when the state first lands. After
  // that the merchant's own navigation owns the current step.
  useEffect(() => {
    if (step === null && stateQuery.data) {
      setStep(resumeStepFor(stateQuery.data));
    }
  }, [step, stateQuery.data]);

  const advance = useMutation({
    mutationFn: (input: Parameters<typeof api.onboardingAdvance>[1]) =>
      api.onboardingAdvance(ctx, input),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: qk.onboarding(ctx.workspaceId) }),
  });

  const finish = useMutation({
    mutationFn: () => api.onboardingComplete(ctx),
    onSuccess: async () => {
      // The shell gate reads onboardingPending off the workspace list, so that
      // has to be refetched or it would bounce us straight back in here.
      await qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success("You're all set. Welcome aboard.");
      nav.replace("/");
    },
    onError: () => toast.warning("Couldn't finish setup. Please try again."),
  });

  const dismiss = useMutation({
    mutationFn: () => api.onboardingDismiss(ctx),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.info("Setup paused. You can finish it any time from Settings.");
      nav.replace("/");
    },
    onError: () => toast.warning("Couldn't pause setup. Please try again."),
  });

  const state = stateQuery.data;
  const current = step;
  const def = useMemo(() => (current ? stepDefFor(current) : null), [current]);

  if (stateQuery.isLoading || !state || !current || !def) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const index = stepIndex(current);
  const isLast = index === WIZARD_STEPS.length - 1;
  const canEdit = session.permissions.has(def.permission);

  const goTo = (next: OnboardingStepKeyView) => {
    setStep(next);
    // Persist the bookmark so a reload — or a trip through Shopify's consent
    // screen — comes back here rather than to the top of the wizard.
    advance.mutate({ nextStep: next });
  };

  const record = (status: "done" | "skipped") => {
    const next = isLast ? null : WIZARD_STEPS[index + 1]!;
    advance.mutate({
      step: current,
      status,
      ...(next ? { nextStep: next } : {}),
    });
    if (next) setStep(next);
    else finish.mutate();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">
              Set up {session.activeWorkspace.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              A few minutes now, and your agent can start handling tickets.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
          >
            Set up later
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 sm:px-6 md:grid-cols-[220px_1fr]">
        <WizardStepper
          steps={WIZARD_STEP_DEFS}
          current={current}
          statuses={state.steps}
          onSelect={goTo}
        />

        <main className="min-w-0 space-y-6">
          <SetupWarnings state={state} />

          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Step {index + 1} of {WIZARD_STEPS.length}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              {def.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{def.blurb}</p>
          </div>

          {!canEdit && (
            <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
              You don't have permission to change this. Ask an admin to set it
              up, or skip ahead — you can come back to it later.
            </p>
          )}

          <def.Component onDone={() => record("done")} canEdit={canEdit} />

          <div className="flex flex-wrap items-center gap-3 border-t pt-6">
            {index > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goTo(WIZARD_STEPS[index - 1]!)}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            )}
            <div className="ml-auto flex items-center gap-3">
              {def.skippable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => record("skipped")}
                  disabled={finish.isPending}
                >
                  Skip for now
                </Button>
              )}
              {isLast && (
                <Button
                  size="sm"
                  onClick={() => record("done")}
                  disabled={finish.isPending}
                >
                  {finish.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Check className="size-4" />
                  )}
                  Finish setup
                </Button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
