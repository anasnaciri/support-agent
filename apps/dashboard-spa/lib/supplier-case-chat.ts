// Pure, framework-free logic for the supplier case chat view. Kept out of the
// React component so the route predicate (AppShell's full-bleed switch) and
// the escalation → bubbles derivation are unit-testable (mirrors
// cases-sidebar-data.ts).

import type { SupplierEscalationDetailView } from "@/lib/api-client";

/**
 * The escalation id for a `/supplier/cases/<id>` detail route, or null for the
 * bare list and every other route. Doubles as the "render the supplier chat
 * full-bleed" predicate in AppShell (non-null ⇒ an escalation is open).
 */
export const supplierEscalationIdFromPathname = (
  pathname: string,
): string | null => {
  const match = /^\/supplier\/cases\/([^/]+)/.exec(pathname);
  return match ? (match[1] ?? null) : null;
};

export interface SupplierChatMessage {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly sender: string;
  /** ISO timestamp, or null when the source row doesn't carry one. */
  readonly sentAt: string | null;
  readonly body: string;
  /** The supplier's suggested resolution — outbound messages only. */
  readonly resolution: string | null;
}

/**
 * The escalation as a chat transcript: the support team's "what's needed"
 * request as the inbound message, and — once the supplier has responded
 * (status resolved) — their posted update as the outbound reply. A note on an
 * unresolved escalation is never shown: the update only exists once posting it
 * flipped the status.
 */
export const supplierChatMessages = (
  detail: SupplierEscalationDetailView,
): ReadonlyArray<SupplierChatMessage> => {
  const request: SupplierChatMessage = {
    id: `${detail.id}-request`,
    direction: "inbound",
    sender: "Support team",
    sentAt: detail.createdAt,
    body: detail.problem,
    resolution: null,
  };
  if (detail.status !== "resolved") return [request];
  return [
    request,
    {
      id: `${detail.id}-update`,
      direction: "outbound",
      sender: "You",
      sentAt: null,
      body: detail.note ?? "(no note recorded)",
      resolution: detail.proposedResolution,
    },
  ];
};
