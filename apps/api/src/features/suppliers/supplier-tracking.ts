// ============================================================
// Supplier portal "fix the tracking number" — orchestration core
// ============================================================
//
// A supplier who reshipped (or whose carrier re-labelled a parcel) holds the
// truth about the order's tracking number, but until now could only paste it
// into their free-text update for a human to act on. This closes that gap
// from the escalation page: the new number is written to the REAL Shopify
// fulfillment (so the customer's order status page and the ticket's tracking
// card update), under the authenticated supplier's authority.
//
// This is the dependency-injected orchestration core (same shape as
// `updateTicketShippingAddress`): pure async over its deps so it unit-tests
// with fakes. The HTTP handler wires `loadFulfillments` / `update` /
// `recordUpdated` to the live services and owns the escalation authz guard
// (this supplier's, still open) BEFORE calling in here.
//
// Which fulfillment? An order can carry several. The escalation's own
// tracking-number projection is the disambiguator: the fulfillment currently
// carrying that number is the one the supplier is talking about. No match →
// only an order with exactly ONE fulfillment is safe to update; anything
// else is ambiguous and refused rather than guessed.

import {
  SHOPIFY_FULFILLMENT_TRACKING_PERMISSION,
  SHOPIFY_FULFILLMENT_TRACKING_SCOPES,
} from "@support-agent/dashboard-contracts";

/** The projection of a Shopify fulfillment the picking logic needs. */
export interface SupplierFulfillmentView {
  readonly id: string;
  readonly trackingNumbers: ReadonlyArray<string>;
  readonly trackingCompany: string | null;
}

/** What Shopify stored, as reported back to the supplier. */
export interface StoredTracking {
  readonly trackingNumbers: ReadonlyArray<string>;
  readonly trackingCompany: string | null;
}

export type UpdateSupplierTrackingOutcome =
  | {
      readonly kind: "saved";
      readonly trackingNumber: string;
      readonly trackingCompany: string | null;
    }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "no_fulfillment" }
  | { readonly kind: "ambiguous_fulfillment" }
  | {
      readonly kind: "shopify_permission_required";
      readonly requiredScopes: ReadonlyArray<
        (typeof SHOPIFY_FULFILLMENT_TRACKING_SCOPES)[number]
      >;
      readonly requiredPermission: typeof SHOPIFY_FULFILLMENT_TRACKING_PERMISSION;
    }
  | { readonly kind: "update_failed"; readonly error: string };

export interface UpdateSupplierTrackingOptions {
  /** The new tracking number (trimmed, non-empty — the handler validates). */
  readonly trackingNumber: string;
  /** The carrier, or null when the supplier didn't name one. */
  readonly trackingCompany: string | null;
  /** The escalation's tracking-number projection (the number being replaced). */
  readonly currentTrackingNumber: string | null;
  /**
   * Resolve the ticket's order and list its fulfillments; `null` = the order
   * couldn't be resolved (no bound order, no creds, revoked connector).
   */
  readonly loadFulfillments: () => Promise<ReadonlyArray<SupplierFulfillmentView> | null>;
  /**
   * Write the new tracking info through Shopify. Resolves with what Shopify
   * stored. Throws/rejects on failure.
   */
  readonly update: (args: {
    readonly fulfillmentId: string;
    readonly trackingNumber: string;
    readonly trackingCompany: string | null;
  }) => Promise<StoredTracking>;
  /** Best-effort post-write bookkeeping (escalation stamp + audit). */
  readonly recordUpdated: (args: {
    readonly fulfillmentId: string;
    readonly trackingNumber: string;
    readonly trackingCompany: string | null;
  }) => Promise<void>;
}

const pickFulfillment = (
  fulfillments: ReadonlyArray<SupplierFulfillmentView>,
  currentTrackingNumber: string | null,
): SupplierFulfillmentView | "none" | "ambiguous" => {
  if (fulfillments.length === 0) return "none";
  if (currentTrackingNumber !== null) {
    const match = fulfillments.find((f) =>
      f.trackingNumbers.includes(currentTrackingNumber),
    );
    if (match) return match;
  }
  if (fulfillments.length === 1) return fulfillments[0]!;
  return "ambiguous";
};

const shopifyPermissionDenied = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes("fulfillmenttrackinginfoupdate") &&
    (m.includes("access denied") ||
      m.includes("required access") ||
      m.includes(SHOPIFY_FULFILLMENT_TRACKING_PERMISSION) ||
      SHOPIFY_FULFILLMENT_TRACKING_SCOPES.some((scope) =>
        m.includes(scope),
      ))
  );
};

export const updateSupplierTracking = async (
  opts: UpdateSupplierTrackingOptions,
): Promise<UpdateSupplierTrackingOutcome> => {
  const fulfillments = await opts.loadFulfillments();
  if (fulfillments === null) return { kind: "order_not_found" };

  const picked = pickFulfillment(fulfillments, opts.currentTrackingNumber);
  if (picked === "none") return { kind: "no_fulfillment" };
  if (picked === "ambiguous") return { kind: "ambiguous_fulfillment" };

  // No carrier named → carry the fulfillment's current one over, so replacing
  // the number doesn't silently drop the carrier (Shopify derives the
  // tracking URL from it).
  const trackingCompany = opts.trackingCompany ?? picked.trackingCompany;

  let stored: StoredTracking;
  try {
    stored = await opts.update({
      fulfillmentId: picked.id,
      trackingNumber: opts.trackingNumber,
      trackingCompany,
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (shopifyPermissionDenied(error)) {
      return {
        kind: "shopify_permission_required",
        requiredScopes: [...SHOPIFY_FULFILLMENT_TRACKING_SCOPES],
        requiredPermission: SHOPIFY_FULFILLMENT_TRACKING_PERMISSION,
      };
    }
    return {
      kind: "update_failed",
      error,
    };
  }

  const storedNumber = stored.trackingNumbers[0] ?? opts.trackingNumber;
  try {
    await opts.recordUpdated({
      fulfillmentId: picked.id,
      trackingNumber: storedNumber,
      trackingCompany: stored.trackingCompany,
    });
  } catch (cause) {
    // The tracking already changed on the store — never report failure over
    // bookkeeping. Surface it in logs for follow-up.
    // eslint-disable-next-line no-console
    console.error("[supplier tracking] post-update bookkeeping failed", {
      cause,
    });
  }

  return {
    kind: "saved",
    trackingNumber: storedNumber,
    trackingCompany: stored.trackingCompany,
  };
};
