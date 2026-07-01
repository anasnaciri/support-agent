import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { Link } from "@/components/ui/link";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// The supplier "post an update" form: an open escalation shows the form; posting
// it (api.supplierUpdate) flips the case to resolved and records the note, which
// the resolved branch then renders. Everything else is the faithful display port.

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
  const qc = useQueryClient();

  const [note, setNote] = useState("");
  const [proposedResolution, setProposedResolution] = useState("");

  const { data: detail, isLoading } = useQuery({
    queryKey: qk.supplierCase(ctx.workspaceId, id),
    queryFn: () => api.supplierCase(ctx, id),
    enabled: allowed && id.length > 0,
  });

  const update = useMutation({
    mutationFn: () =>
      api.supplierUpdate(ctx, id, {
        note,
        proposedResolution: proposedResolution.trim() ? proposedResolution : null,
      }),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning(
          `We couldn't record that update (error ${res.status}). Please try again.`,
        );
        return;
      }
      toast.success(
        "Thanks — your update was recorded and the case is being handled.",
      );
      void qc.invalidateQueries({
        queryKey: qk.supplierCase(ctx.workspaceId, id),
      });
      void qc.invalidateQueries({
        queryKey: qk.supplierCases(ctx.workspaceId),
      });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate();
  };

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
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-lg border border-border bg-background p-5"
        >
          <div className="space-y-1.5">
            <Label htmlFor="note">Your update</Label>
            <Textarea
              id="note"
              required
              rows={5}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you find / do? (e.g. reshipped via DHL, new ETA Friday)"
            />
            <p className="text-xs text-muted-foreground">
              The support team turns this into a customer reply — write it for
              them, not the customer.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proposedResolution">
              Suggested resolution (optional)
            </Label>
            <Textarea
              id="proposedResolution"
              rows={2}
              value={proposedResolution}
              onChange={(e) => setProposedResolution(e.target.value)}
              placeholder="e.g. reship, refund, wait 3 days"
            />
          </div>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Submitting…" : "Submit update"}
          </Button>
        </form>
      )}
    </div>
  );
}
