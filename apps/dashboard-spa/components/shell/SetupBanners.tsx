import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { hasMailbox, setupGaps } from "@/lib/setup-readiness";
import { SetupGapAlert } from "@/features/onboarding/SetupWarnings";

// The setup gaps that survive the wizard, restated wherever the merchant works.
//
// A merchant who skipped the AI provider step has a dashboard that will never
// answer a ticket, and the failure is silent: mail arrives, tickets open, and
// every one of them parks in human takeover. That is worth a banner on every
// page until it's fixed — it is not a nag, it is the product telling the truth
// about what it can currently do.
//
// Once both gaps are closed this renders nothing, forever.

export function SetupBanners() {
  const ctx = useWorkspaceCtx();

  const llm = useQuery({
    queryKey: qk.llmStatus(ctx.workspaceId),
    queryFn: () => api.llmStatus(ctx),
    staleTime: 60_000,
  });
  const connections = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
    staleTime: 60_000,
  });

  // Say nothing until we actually know: a banner that flashes on every page load
  // and then vanishes is worse than no banner.
  if (llm.isLoading || connections.isLoading) return null;

  // `steps: null` — outside the wizard there is no "they haven't been asked yet".
  const gaps = setupGaps({
    llmConnected: Boolean(llm.data?.effective),
    mailboxConnected: hasMailbox(connections.data ?? []),
    steps: null,
  });
  if (gaps.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {gaps.map((gap) => (
        <SetupGapAlert key={gap.kind} gap={gap} />
      ))}
    </div>
  );
}
