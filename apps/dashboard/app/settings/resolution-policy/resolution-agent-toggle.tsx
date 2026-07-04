"use client";

import { toggleResolutionAgentAction } from "./actions";

/**
 * On/off switch for routing new tickets to the resolution agent. Submits the
 * server action on change (no Save button) and the page revalidates in place.
 */
export function ResolutionAgentToggle({ enabled }: { readonly enabled: boolean }) {
  return (
    <form action={toggleResolutionAgentAction}>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="size-4 rounded border-input accent-primary"
        />
        <span className="text-sm font-medium">
          Route new tickets to the resolution agent
        </span>
      </label>
    </form>
  );
}
