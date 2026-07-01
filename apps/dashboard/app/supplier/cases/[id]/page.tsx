import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api-client";
import { requireSupplierPermission } from "@/lib/require-supplier-permission";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { postSupplierUpdateAction } from "./actions";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<{ readonly updated?: string }>;
}

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

export default async function SupplierCasePage({ params, searchParams }: Params) {
  const { id } = await params;
  const { updated } = await searchParams;
  const ctx = await requireSupplierPermission();
  const detail = await api.supplierCase(ctx, id);
  if (!detail) notFound();

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

      {updated === "ok" ? (
        <Alert>
          <AlertDescription>
            Thanks — your update was recorded and the case is being handled.
          </AlertDescription>
        </Alert>
      ) : updated && updated !== "ok" ? (
        <Alert variant="destructive">
          <AlertDescription>
            We couldn&apos;t record that update (error {updated}). Please try
            again.
          </AlertDescription>
        </Alert>
      ) : null}

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
          action={postSupplierUpdateAction}
          className="space-y-4 rounded-lg border border-border bg-background p-5"
        >
          <input type="hidden" name="escalationId" value={detail.id} />
          <div className="space-y-1.5">
            <Label htmlFor="note">Your update</Label>
            <Textarea
              id="note"
              name="note"
              required
              rows={5}
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
              name="proposedResolution"
              rows={2}
              placeholder="e.g. reship, refund, wait 3 days"
            />
          </div>
          <SubmitButton pendingLabel="Submitting…">Submit update</SubmitButton>
        </form>
      )}
    </div>
  );
}
