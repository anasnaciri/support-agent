import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ArrowLeft, PanelRightClose, PanelRightOpen } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { cn } from "@/lib/utils";
import {
  supplierChatMessages,
  type SupplierChatMessage,
} from "@/lib/supplier-case-chat";
import { Link } from "@/components/ui/link";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// The escalation as a chat: the support team's request is an inbound bubble,
// the supplier's posted update the outbound reply, and the "post an update"
// form the composer pinned at the bottom (posting flips the case to resolved).
// The order context lives in a card pinned to the chat's top right: it slides
// in from behind the stage's right edge and an invisible spacer column widens
// with it, nudging the bubbles left instead of letting the card cover them.

/** Width reserved for the context card's invisible column (card + gutters). */
const CONTEXT_COLUMN = "md:w-80";

const formatDateTime = (date: string): string =>
  date.slice(0, 16).replace("T", " ");

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

const Bubble = ({ message }: { readonly message: SupplierChatMessage }) => {
  const outbound = message.direction === "outbound";
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1",
        outbound ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "flex max-w-[85%] min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground",
          outbound ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className="min-w-0 truncate font-medium text-foreground/70">
          {message.sender}
        </span>
        {message.sentAt ? (
          <>
            <span>·</span>
            <span className="font-mono">{formatDateTime(message.sentAt)}</span>
          </>
        ) : null}
      </div>
      <div
        className={cn(
          "max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
          outbound
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border border-border bg-card text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.resolution ? (
          <p className="mt-2 border-t border-primary-foreground/25 pt-2 text-[13px] text-primary-foreground/85">
            Suggested resolution: {message.resolution}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export function SupplierCaseDetailPage() {
  const allowed = useRequirePermission("supplier.cases.view");
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { escalationId?: string }).escalationId ?? "";
  const qc = useQueryClient();

  const [note, setNote] = useState("");
  const [proposedResolution, setProposedResolution] = useState("");
  const [contextOpen, setContextOpen] = useState(true);

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
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-sm font-medium">Escalation not found</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/supplier/cases">← All escalated cases</Link>
          </Button>
        </div>
      </div>
    );
  }

  const resolved = detail.status === "resolved";
  const shipTo = [detail.shipCity, detail.shipCountry]
    .filter(Boolean)
    .join(", ");
  const messages = supplierChatMessages(detail);
  const hasContext = Boolean(detail.orderRef || detail.trackingNumber || shipTo);
  const showContext = contextOpen && hasContext;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4 py-2.5">
        <Link
          href="/supplier/cases"
          aria-label="All escalated cases"
          title="All escalated cases"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold tracking-tight">
            {detail.orderRef ?? "Escalated case"}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {resolved
              ? "You've responded to this case."
              : "Review what's needed and post your update."}
          </p>
        </div>
        {hasContext ? (
          <button
            type="button"
            onClick={() => setContextOpen((v) => !v)}
            aria-expanded={contextOpen}
            aria-label={contextOpen ? "Hide order context" : "Show order context"}
            title={contextOpen ? "Hide order context" : "Show order context"}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {contextOpen ? (
              <PanelRightClose className="size-4" aria-hidden />
            ) : (
              <PanelRightOpen className="size-4" aria-hidden />
            )}
          </button>
        ) : null}
      </header>

      {/* The chat stage — overflow-hidden parks the context card just past the
          right edge, so opening it reads as sliding out from behind that edge. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="thin-scrollbar h-full min-w-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
          </div>
        </div>

        {/* The card's invisible column: an empty spacer that widens with the
            card (md+ only — on phones the card floats over the chat instead),
            pushing the centered bubble column left. */}
        <div
          aria-hidden
          className={cn(
            "w-0 shrink-0 transition-[width] duration-300 ease-in-out",
            showContext && CONTEXT_COLUMN,
          )}
        />

        {hasContext ? (
          <aside
            aria-hidden={!showContext}
            aria-label="Order context"
            className={cn(
              "thin-scrollbar absolute right-4 top-4 max-h-[calc(100%-2rem)] w-72 max-w-[85vw] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-md transition-transform duration-300 ease-in-out",
              showContext
                ? "translate-x-0"
                : "pointer-events-none translate-x-[calc(100%+1rem)]",
            )}
          >
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Context
            </h2>
            <dl className="space-y-3 pt-3">
              <Field label="Order" value={detail.orderRef} />
              <Field label="Tracking" value={detail.trackingNumber} />
              <Field label="Ship to" value={shipTo || null} />
            </dl>
          </aside>
        ) : null}
      </div>

      <div className="thin-scrollbar max-h-[60%] shrink-0 overflow-y-auto border-t border-border/60 bg-card px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          {resolved ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              You&apos;ve responded to this case — the support team is handling
              it from here.
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="note">Your update</Label>
                <Textarea
                  id="note"
                  required
                  rows={3}
                  className="min-h-[76px]"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What did you find / do? (e.g. reshipped via DHL, new ETA Friday)"
                />
                <p className="text-xs text-muted-foreground">
                  The support team turns this into a customer reply — write it
                  for them, not the customer.
                </p>
              </div>
              <div className="flex items-end gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="proposedResolution">
                    Suggested resolution (optional)
                  </Label>
                  <Textarea
                    id="proposedResolution"
                    rows={1}
                    className="min-h-9"
                    value={proposedResolution}
                    onChange={(e) => setProposedResolution(e.target.value)}
                    placeholder="e.g. reship, refund, wait 3 days"
                  />
                </div>
                <Button type="submit" disabled={update.isPending}>
                  {update.isPending ? "Submitting…" : "Submit update"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
