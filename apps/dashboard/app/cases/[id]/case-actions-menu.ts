// The case-page overflow (⋮) menu. Holds case actions that don't warrant a
// dedicated button in the header row — a home for the actions we'll keep
// adding. Kept pure + tested so the menu's contents stay easy to reason about.

export type CaseActionKey = "retryNow" | "retryFromTriage";

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
 * Which actions live in the overflow menu, given case state. Available while
 * the case is under human takeover. Two retry shapes:
 *  - "Retry last step" re-runs the case's CURRENT agent (the bound specialist).
 *  - "Restart from triage" rebinds the case to triage so the agent
 *    re-classifies + re-routes from scratch — use when the routing was wrong.
 */
export const caseActionMenuItems = ({
  canResume,
}: CaseActionMenuInput): ReadonlyArray<CaseActionMenuItemMeta> => {
  const items: CaseActionMenuItemMeta[] = [];
  if (canResume) {
    items.push({
      key: "retryNow",
      label: "Retry last step",
      pendingLabel: "Retrying…",
      title:
        "Hand the case back and re-run the current agent's last step right now",
    });
    items.push({
      key: "retryFromTriage",
      label: "Restart from triage",
      pendingLabel: "Restarting…",
      title:
        "Hand the case back and restart from triage — the agent re-classifies and re-routes from scratch",
    });
  }
  return items;
};
