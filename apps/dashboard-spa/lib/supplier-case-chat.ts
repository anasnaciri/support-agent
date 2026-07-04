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

export interface TrackingEditFeedback {
  readonly kind: "success" | "error";
  readonly message: string;
}

/**
 * Friendly feedback for the tracking-edit response (supplier-facing copy —
 * no store/Shopify jargon, and server error detail is never echoed). Every
 * "couldn't write it to the order" outcome redirects the supplier to their
 * written update, which always reaches the support team.
 */
export const trackingEditFeedback = (
  status: number,
  body: unknown,
): TrackingEditFeedback => {
  if (status === 200) {
    return {
      kind: "success",
      message: "Tracking number updated on the order.",
    };
  }
  const rec =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const code = typeof rec["kind"] === "string" ? rec["kind"] : rec["error"];
  switch (code) {
    case "already_resolved":
      return {
        kind: "error",
        message:
          "You've already responded to this case — the tracking number can no longer be changed from here.",
      };
    case "order_not_found":
      return {
        kind: "error",
        message:
          "We couldn't match this case to an order, so the tracking number wasn't changed. Include it in your update below instead.",
      };
    case "no_fulfillment":
      return {
        kind: "error",
        message:
          "This order has no shipment to update yet, so the tracking number wasn't changed. Include it in your update below instead.",
      };
    case "ambiguous_fulfillment":
      return {
        kind: "error",
        message:
          "This order has several shipments and we can't tell which one you mean, so the tracking number wasn't changed. Include it in your update below instead.",
      };
    default:
      return {
        kind: "error",
        message: "We couldn't update the tracking number. Please try again.",
      };
  }
};
