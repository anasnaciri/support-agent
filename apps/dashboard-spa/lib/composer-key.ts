// Structurally compatible with ChatComposer's ComposerMode — declared here so
// lib/ keeps its no-imports-from-features boundary.
export type ComposerKeyMode =
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly draftBody: string;
    }
  | { readonly kind: "reply" }
  | { readonly kind: "locked" };

// React key for the ChatComposer instance on the ticket page. The composer
// seeds its textarea from the mode ONCE, on mount — so the key must change
// exactly when that seed must be re-read:
//  - a live refresh flips locked → approval (the drafted reply must fill the
//    input without a page refresh),
//  - a different approval becomes the pending one,
//  - the same approval is redrafted with a new body (e.g. a supplier update
//    while waiting_for_approval).
// It must NOT change on ordinary refetches of the same pending approval, or
// the manager's in-progress edits would be wiped.
export const composerKey = (
  ticketId: string,
  mode: ComposerKeyMode,
): string =>
  mode.kind === "approval"
    ? `${ticketId}:approval:${mode.approvalId}:${mode.draftBody}`
    : ticketId;
