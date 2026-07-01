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
  caseActionFeedback,
  type ActionFeedback,
  type CaseAction,
} from "./case-action-feedback";

// Shared wiring for every case-page mutation: run the api call, toast the
// discriminated outcome (the Next app's post-redirect banner copy), and
// invalidate the case detail + the cases/approvals lists so the view refreshes.
// The case key prefix `["case", w, id]` also covers the thread/shopify/tracking
// sub-queries. An unexpected throw (network/5xx) surfaces a generic error toast.

export interface CaseMutationResult {
  readonly kind: string;
}

const invalidateCaseQueries = (
  qc: QueryClient,
  workspaceId: string,
  caseId: string,
): void => {
  void qc.invalidateQueries({ queryKey: qk.case(workspaceId, caseId) });
  void qc.invalidateQueries({ queryKey: ["cases", workspaceId] });
  void qc.invalidateQueries({ queryKey: ["approvals", workspaceId] });
};

const toastFeedback = (fb: ActionFeedback): void => {
  toast[fb.tone](fb.text);
};

export const useCaseMutation = <TVars = void>(opts: {
  readonly workspaceId: string;
  readonly caseId: string;
  readonly action: CaseAction;
  readonly mutationFn: (vars: TVars) => Promise<CaseMutationResult>;
  /** Runs after the toast + invalidation on success (e.g. close a dialog). */
  readonly onDone?: (kind: string) => void;
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: (result) => {
      toastFeedback(caseActionFeedback(opts.action, result.kind));
      invalidateCaseQueries(qc, opts.workspaceId, opts.caseId);
      opts.onDone?.(result.kind);
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
};

/** Approve/reject a SINGLE approval (composer approval mode + ApprovalCard). */
export const useApprovalDecision = <TVars = void>(opts: {
  readonly workspaceId: string;
  readonly caseId: string;
  readonly action: "approve" | "reject";
  readonly mutationFn: (vars: TVars) => Promise<CaseMutationResult>;
  readonly onDone?: (kind: string) => void;
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onSuccess: (result) => {
      toastFeedback(approvalDecisionFeedback(opts.action, result.kind));
      invalidateCaseQueries(qc, opts.workspaceId, opts.caseId);
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

/** Approve-all / reject-remaining a whole-case approval bundle. */
export const useBundleDecision = <TVars = void>(opts: {
  readonly workspaceId: string;
  readonly caseId: string;
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
      invalidateCaseQueries(qc, opts.workspaceId, opts.caseId);
      opts.onDone?.(result.kind);
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
};
