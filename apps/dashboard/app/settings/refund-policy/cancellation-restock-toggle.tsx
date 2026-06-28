"use client";

import { saveCancellationRestockAction } from "./actions";

/**
 * Restock-on-cancel checkbox for the refund-policy page's "Order cancellations"
 * section. Submits the server action on change (no Save button) and the page
 * revalidates in place — same pattern as the resolution-agent toggle.
 */
export function CancellationRestockToggle({
  restock,
}: {
  readonly restock: boolean;
}) {
  return (
    <form action={saveCancellationRestockAction}>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          name="restock"
          defaultChecked={restock}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="size-4 rounded border-input accent-primary"
        />
        <span className="text-sm font-medium">
          Return cancelled items to inventory
        </span>
      </label>
    </form>
  );
}
