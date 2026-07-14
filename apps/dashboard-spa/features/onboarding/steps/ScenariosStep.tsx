import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/components/ui/link";
import type { WizardStepProps } from "../steps";

// Step 5. Read-only on purpose.
//
// The real Scenarios editor is a large surface (per-scenario action envelopes,
// permissions, playbook notes with @fact and /action references). Reproducing it
// here would be a second editor to keep in sync, and would ask a merchant who
// has been in the product for four minutes to make decisions they have no
// grounds for yet. The shipped defaults are good; what this step owes them is
// awareness that the playbooks EXIST and can be changed.

export function ScenariosStep({ onDone }: WizardStepProps) {
  const ctx = useWorkspaceCtx();

  const policy = useQuery({
    queryKey: qk.resolutionPolicy(ctx.workspaceId),
    queryFn: () => api.resolutionPolicy(ctx),
  });

  if (policy.isLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  const scenarios = (policy.data?.scenarios ?? []).filter((s) => s.enabled);

  return (
    <div className="space-y-6">
      <ul className="divide-y rounded-lg border">
        {scenarios.map((s) => (
          <li key={s.key} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {s.label}
            </span>
            <Badge variant="secondary">
              {s.enabledActions.length === 0
                ? "Replies only"
                : `${s.enabledActions.length} action${
                    s.enabledActions.length === 1 ? "" : "s"
                  }`}
            </Badge>
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted-foreground">
        These playbooks decide how your agent handles each kind of request, and
        they already work out of the box. Skip this for now and come back once
        you've seen a few real tickets — that's when you'll know what to change.
        They live under{" "}
        <Link
          href="/settings/scenarios"
          className="font-medium underline underline-offset-4"
        >
          Settings → Scenarios
        </Link>
        .
      </p>

      <Button onClick={onDone}>These look good, continue</Button>
    </div>
  );
}
