import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox } from "lucide-react";
import type { OnboardingStateView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { hasMailbox, setupGaps, type SetupGap } from "@/lib/setup-readiness";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Link } from "@/components/ui/link";

// The two gaps that stop a workspace working, surfaced wherever the merchant
// is. Inside the wizard they appear as soon as the merchant passes the step
// that would have closed them (skipping the AI provider is allowed — being
// quiet about what that costs is not).

const ICONS: Record<SetupGap["kind"], typeof AlertTriangle> = {
  llm: AlertTriangle,
  mailbox: Inbox,
};

export function SetupGapAlert({ gap }: { readonly gap: SetupGap }) {
  const Icon = ICONS[gap.kind];
  return (
    <Alert variant={gap.severity === "error" ? "destructive" : "warning"}>
      <Icon className="size-4" />
      <AlertTitle>{gap.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{gap.detail}</p>
        <Link href={gap.href} className="font-medium underline underline-offset-4">
          {gap.actionLabel}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Wizard-scoped warnings. `state.steps` keeps them quiet until the merchant has
 * actually been asked for the thing that's missing.
 */
export function SetupWarnings({
  state,
}: {
  readonly state: OnboardingStateView;
}) {
  const ctx = useWorkspaceCtx();

  const llmQuery = useQuery({
    queryKey: qk.llmStatus(ctx.workspaceId),
    queryFn: () => api.llmStatus(ctx),
  });
  const connectionsQuery = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
  });

  if (llmQuery.isLoading || connectionsQuery.isLoading) return null;

  const gaps = setupGaps({
    // `effective` is the credential the RUNTIME will actually resolve — the
    // workspace's own key, or the account-level fallback. Either one means the
    // agent can run, so either one closes the gap.
    llmConnected: Boolean(llmQuery.data?.effective),
    mailboxConnected: hasMailbox(connectionsQuery.data ?? []),
    steps: state.steps,
  });
  if (gaps.length === 0) return null;

  return (
    <div className="space-y-3">
      {gaps.map((gap) => (
        <SetupGapAlert key={gap.kind} gap={gap} />
      ))}
    </div>
  );
}
