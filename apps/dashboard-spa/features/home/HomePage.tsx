import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Link } from "@/components/ui/link";
import { Card } from "@/components/ui/card";
import { caseStatusLabel } from "@/lib/labels";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-semibold">{value}</p>
    </Card>
  );
}

export function HomePage() {
  const ctx = useWorkspaceCtx();
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.today(ctx.workspaceId),
    queryFn: () => api.today(ctx),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">Couldn’t load your summary.</p>;
  }

  const totalOpen = Object.entries(data.statusCounts)
    .filter(([s]) => s !== "resolved")
    .reduce((n, [, v]) => n + v, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Today</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Open cases" value={totalOpen} />
        <Stat label="Resolved today" value={data.resolvedTodayCount} />
        <Stat label="Pending approvals" value={data.pendingApprovals.length} />
        <Stat label="Human takeover" value={data.takeoverCases.length} />
      </div>

      {Object.keys(data.statusCounts).length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">By status</h2>
          <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {Object.entries(data.statusCounts).map(([status, count]) => (
              <li key={status} className="flex justify-between gap-2">
                <span className="text-muted-foreground">
                  {caseStatusLabel(status)}
                </span>
                <span className="font-mono">{count}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {data.pendingApprovals.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Waiting on you</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {data.pendingApprovals.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/approvals/${a.id}`}
                  className="text-primary hover:underline"
                >
                  {a.tool}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
