// The case-page overflow (⋮) menu. Holds case actions that don't warrant a
// dedicated button in the header row — a home for the actions we'll keep
// adding. Kept pure + tested so the menu's contents stay easy to reason about.

export type CaseActionKey = "retryNow";

export interface CaseActionMenuItemMeta {
  readonly key: CaseActionKey;
  readonly label: string;
  /** Label swapped in while the action is in flight. */
  readonly pendingLabel: string;
  readonly title: string;
}

export interface CaseActionMenuInput {
  /** True while the case is under human takeover (the only state the agent can
   *  be handed back from). */
  readonly canResume: boolean;
}

/**
 * Which actions live in the overflow menu, given case state. Today it holds
 * only "Retry now" — hand the case back to the agent and tick it immediately —
 * available while the case is under human takeover.
 */
export const caseActionMenuItems = ({
  canResume,
}: CaseActionMenuInput): ReadonlyArray<CaseActionMenuItemMeta> => {
  const items: CaseActionMenuItemMeta[] = [];
  if (canResume) {
    items.push({
      key: "retryNow",
      label: "Retry now",
      pendingLabel: "Retrying…",
      title: "Hand the case back and have the agent try again right now",
    });
  }
  return items;
};
