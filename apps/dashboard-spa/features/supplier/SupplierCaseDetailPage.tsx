import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Link } from "@/components/ui/link";

// ⚠️ Phase 3 = READ-ONLY. The supplier "post an update" form (its
// server-action write) lands in Phase 4; an open escalation shows a read-only
// note in its place. Everything else is the faithful display port.

const Field = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}) =>
  value ? (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="pt-0.5 text-sm">{value}</dd>
    </div>
  ) : null;

export function SupplierCaseDetailPage() {
  const allowed = useRequirePermission("supplier.cases.view");
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { escalationId?: string }).escalationId ?? "";

  const { data: detail, isLoading } = useQuery({
    queryKey: qk.supplierCase(ctx.workspaceId, id),
    queryFn: () => api.supplierCase(ctx, id),
    enabled: allowed && id.length > 0,
  });

  if (!allowed) return null;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Escalation not found</p>
        <Link
          href="/supplier/cases"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All escalated cases
        </Link>
      </div>
    );
  }

  const resolved = detail.status === "resolved";
  const shipTo = [detail.shipCity, detail.shipCountry]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-6">
      <Link
        href="/supplier/cases"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All escalated cases
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {detail.orderRef ?? "Escalated case"}
        </h1>
        <p className="pt-1 text-sm text-muted-foreground">
          {resolved
            ? "You've responded to this case."
            : "Review what's needed and post your update."}
        </p>
      </div>

      <section className="space-y-4 rounded-lg border border-border bg-background p-5">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What&apos;s needed
          </dt>
          <dd className="whitespace-pre-wrap break-words pt-0.5 text-sm">
            {detail.problem}
          </dd>
        </div>
        <dl className="grid grid-cols-2 gap-4">
          <Field label="Order" value={detail.orderRef} />
          <Field label="Tracking" value={detail.trackingNumber} />
          <Field label="Ship to" value={shipTo || null} />
        </dl>
      </section>

      {resolved ? (
        <section className="space-y-2 rounded-lg border border-border bg-background p-5">
          <h2 className="text-sm font-semibold">Your update</h2>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {detail.note ?? "(no note recorded)"}
          </p>
          {detail.proposedResolution ? (
            <p className="text-sm text-muted-foreground">
              Resolution: {detail.proposedResolution}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="space-y-2 rounded-lg border border-border bg-background p-5">
          <h2 className="text-sm font-semibold">Post an update</h2>
          <p className="text-sm text-muted-foreground">
            The update form arrives in a later update. Check back soon to post
            what you found or did on this case.
          </p>
        </section>
      )}
    </div>
  );
}
