import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Link } from "@/components/ui/link";

// The supplier's list of open escalations — only what they need to act, never
// customer PII (the api returns the minimal projection). The api enforces the
// real boundary (decideSupplierAuthz); this client gate is the front door.
export function SupplierCasesPage() {
  const allowed = useRequirePermission("supplier.cases.view");
  const ctx = useWorkspaceCtx();
  const { data, isLoading } = useQuery({
    queryKey: qk.supplierCases(ctx.workspaceId),
    queryFn: () => api.supplierCases(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const cases = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Escalated cases
        </h1>
        <p className="pt-1 text-sm text-muted-foreground">
          Cases escalated to you to chase or resolve. Open one to post an update.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="rounded-lg border border-border bg-background p-6 text-sm text-muted-foreground">
          No open escalations right now.
        </p>
      ) : (
        <ul className="space-y-3">
          {cases.map((c) => {
            const shipTo = [c.shipCity, c.shipCountry]
              .filter(Boolean)
              .join(", ");
            return (
              <li key={c.id}>
                <Link
                  href={`/supplier/cases/${c.id}`}
                  className="block rounded-lg border border-border bg-background p-4 transition-colors hover:border-foreground/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {c.orderRef ?? "Order (no reference)"}
                    </span>
                    {c.trackingNumber ? (
                      <span className="text-xs text-muted-foreground">
                        Tracking {c.trackingNumber}
                      </span>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 pt-1 text-sm text-muted-foreground">
                    {c.problem}
                  </p>
                  {shipTo ? (
                    <p className="pt-2 text-xs text-muted-foreground">
                      Ship to: {shipTo}
                    </p>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
