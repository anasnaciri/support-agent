import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { qk } from "./query-keys";
import { caseActionFeedback, type CaseAction } from "./case-action-feedback";

// Shared wiring for every case-page mutation: run the api call, toast the
// discriminated outcome (the Next app's post-redirect banner copy), and
// invalidate the case detail + the cases/approvals lists so the view refreshes.
// The case key prefix `["case", w, id]` also covers the thread/shopify/tracking
// sub-queries. An unexpected throw (network/5xx) surfaces a generic error toast.

export interface CaseMutationResult {
  readonly kind: string;
}

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
      const fb = caseActionFeedback(opts.action, result.kind);
      toast[fb.tone](fb.text);
      void qc.invalidateQueries({
        queryKey: qk.case(opts.workspaceId, opts.caseId),
      });
      void qc.invalidateQueries({ queryKey: ["cases", opts.workspaceId] });
      void qc.invalidateQueries({ queryKey: ["approvals", opts.workspaceId] });
      opts.onDone?.(result.kind);
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
};
