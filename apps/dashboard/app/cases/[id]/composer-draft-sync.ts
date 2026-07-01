// Pure draft-sync logic for the case composer, split out (like `live-status.ts`)
// so it's unit-testable without the React component. The composer stays mounted
// across live refreshes (CaseLiveBoundary's `router.refresh()`), so its
// `useState` never re-initializes when a new agent draft arrives — this decides
// when the editor should adopt a (new) draft.

/**
 * What the composer is for, decided by the case's state on the server:
 *  - `approval`: a drafted agent reply is awaiting the manager's call. The draft
 *    fills the input; the controls become a subtle gray Reject (✗) circle and
 *    the regular blue Send button, which approves and sends the draft.
 *  - `reply`: the manager has taken the case over and writes the reply by hand.
 *  - `locked`: the agent owns the conversation — the input is read-only with a
 *    hint to take over.
 */
export type ComposerMode =
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly draftBody: string;
      readonly returnTo: string;
    }
  | { readonly kind: "reply" }
  | { readonly kind: "locked"; readonly message: string };

/** The approval id whose draft the editor is showing, or null when not reviewing one. */
export const activeApprovalId = (mode: ComposerMode): string | null =>
  mode.kind === "approval" ? mode.approvalId : null;

export interface DraftSync {
  /** Text the editor should now hold. */
  readonly text: string;
  /** The approval id now loaded into the editor (null when none). */
  readonly loadedApprovalId: string | null;
}

/**
 * Decide whether the editor should reload its text for `mode`, given the
 * approval id whose draft it currently holds. Returns the new text + loaded id
 * when a different draft (or none) has become active, or `null` when the
 * loaded draft is unchanged — so the operator's edits to the draft they're
 * reviewing are never clobbered by a live refresh.
 */
export function resyncDraft(
  mode: ComposerMode,
  loadedApprovalId: string | null,
): DraftSync | null {
  const active = activeApprovalId(mode);
  // Same draft still loaded (or still none) — keep whatever's in the editor so
  // the operator's edits survive the poll.
  if (active === loadedApprovalId) return null;
  return {
    text: mode.kind === "approval" ? mode.draftBody : "",
    loadedApprovalId: active,
  };
}
