import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { qk } from "./query-keys";
import {
  approvalDecisionFeedback,
  bundleDecisionFeedback,
  ticketActionFeedback,
  type ActionFeedback,
  type TicketAction,
} from "./ticket-action-feedback";

// Shared wiring for every ticket-page mutation: run the api call, toast the
// discriminated outcome (the Next app's post-redirect banner copy), and
// invalidate the ticket detail + the tickets/approvals lists so the view refreshes.
// The ticket key prefix `["ticket", w, id]` also covers the thread/shopify/tracking
// sub-queries. An unexpected throw (network/5xx) surfaces a generic error toast.

export interface TicketMutationResult {
  readonly kind: string;
}

const invalidateTicketQueries = (
  qc: QueryClient,
  workspaceId: string,
  ticketId: string,
): void => {
  void qc.invalidateQueries({ queryKey: qk.ticket(workspaceId, ticketId) });
  void qc.invalidateQueries({ queryKey: ["tickets", workspaceId] });
  void qc.invalidateQueries({ queryKey: ["approvals", workspaceId] });
};

const toastFeedback = (fb: ActionFeedback): void => {
  toast[fb.tone](fb.text);
};

export const useTicketMutation = <TVars = void, TCtx = unknown>(opts: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly action: TicketAction;
  readonly mutationFn: (vars: TVars) => Promise<TicketMutationResult>;
  /** Runs after the toast + invalidation on success (e.g. close a dialog). */
  readonly onDone?: (kind: string) => void;
  /**
   * Optimistic pre-flight, run before the request. Its return value is handed
   * back to `onError` so an optimistic cache write can be rolled back on failure.
   */
  readonly onMutate?: (vars: TVars) => TCtx | Promise<TCtx>;
  /** Undo any optimistic state here; runs before the generic error toast. */
  readonly onError?: (ctx: TCtx | undefined) => void;
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    // Spread conditionally: exactOptionalPropertyTypes rejects `onMutate: undefined`.
    ...(opts.onMutate ? { onMutate: opts.onMutate } : {}),
    onSuccess: (result) => {
      toastFeedback(ticketActionFeedback(opts.action, result.kind));
      invalidateTicketQueries(qc, opts.workspaceId, opts.ticketId);
      opts.onDone?.(result.kind);
    },
    onError: (_err, _vars, ctx) => {
      opts.onError?.(ctx as TCtx | undefined);
      toast.warning("Something went wrong. Please try again.");
    },
  });
};

/** Approve/reject a SINGLE approval (composer approval mode + ApprovalCard). */
export const useApprovalDecision = <TVars = void>(opts: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly action: "approve" | "reject";
  readonly mutationFn: (vars: TVars) => Promise<TicketMutationResult>;
  readonly onDone?: (kind: string) => void;
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: (result) => {
      toastFeedback(approvalDecisionFeedback(opts.action, result.kind));
      invalidateTicketQueries(qc, opts.workspaceId, opts.ticketId);
      opts.onDone?.(result.kind);
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
};

export interface BundleMutationResult {
  readonly kind: string;
  readonly count?: number;
}

/** Approve-all / reject-remaining a whole-ticket approval bundle. */
export const useBundleDecision = <TVars = void>(opts: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly action: "approve" | "reject";
  readonly mutationFn: (vars: TVars) => Promise<BundleMutationResult>;
  readonly onDone?: (kind: string) => void;
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: (result) => {
      toastFeedback(
        bundleDecisionFeedback(opts.action, result.kind, result.count),
      );
      invalidateTicketQueries(qc, opts.workspaceId, opts.ticketId);
      opts.onDone?.(result.kind);
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
};
