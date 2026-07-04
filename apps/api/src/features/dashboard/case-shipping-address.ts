// ============================================================
// Dashboard "edit Ship-to" — operator fixes the order's shipping address
// ============================================================
//
// The most common pre-fulfillment support fix: the customer typo'd their
// address (wrong apartment, old street) and writes in before the parcel ships.
// The agent can't change an order, and until now neither could the operator
// without leaving for the Shopify admin. This closes that gap from the case
// page's Order card, writing the correction to the REAL order via
// `orderUpdate` under operator authorization.
//
// This is the dependency-injected orchestration core (same shape as
// `issueCaseRefund`): pure async over its deps so it unit-tests with fakes.
// The HTTP handler wires `loadOrder` / `update` / `recordUpdated` to the live
// services.
//
// Merge semantics: Shopify's `OrderInput.shippingAddress` replaces the WHOLE
// address, but the pencil form submits only the non-empty fields ("empty =
// no change", like the Customer/Order pencils). So we merge the submitted
// fields over the order's current address before writing — an operator fixing
// the ZIP doesn't wipe the street. Consequence: a field can't be CLEARED from
// this form, only replaced.

/** The full address shape, as read from and written to the order. */
export interface ShippingAddressView {
  readonly name: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly country: string | null;
  readonly zip: string | null;
  readonly phone: string | null;
}

/** The submitted correction — only the fields the operator typed. */
export interface ShippingAddressEditFields {
  readonly name?: string;
  readonly address1?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly province?: string;
  readonly country?: string;
  readonly zip?: string;
  readonly phone?: string;
}

export type UpdateShippingAddressOutcome =
  | { readonly kind: "saved"; readonly address: ShippingAddressView }
  | { readonly kind: "nothing_to_update" }
  | { readonly kind: "order_not_found" }
  | { readonly kind: "update_failed"; readonly error: string };

export interface UpdateCaseShippingAddressOptions {
  /** Trimmed, non-empty fields only (the handler drops blanks). */
  readonly fields: ShippingAddressEditFields;
  /** Resolve the case's order + its current address; `null` = no order. */
  readonly loadOrder: () => Promise<{
    readonly orderId: string;
    readonly address: ShippingAddressView | null;
  } | null>;
  /**
   * Write the merged address through Shopify. Resolves with the address as
   * Shopify stored (normalized) it. Throws/rejects on failure.
   */
  readonly update: (args: {
    readonly orderId: string;
    readonly address: ShippingAddressView;
  }) => Promise<ShippingAddressView>;
  /** Best-effort post-write bookkeeping (audit). */
  readonly recordUpdated: (address: ShippingAddressView) => Promise<void>;
}

const EMPTY_ADDRESS: ShippingAddressView = {
  name: null,
  address1: null,
  address2: null,
  city: null,
  province: null,
  country: null,
  zip: null,
  phone: null,
};

export const updateCaseShippingAddress = async (
  opts: UpdateCaseShippingAddressOptions,
): Promise<UpdateShippingAddressOutcome> => {
  const f = opts.fields;
  if (Object.values(f).every((v) => v === undefined)) {
    return { kind: "nothing_to_update" };
  }

  const order = await opts.loadOrder();
  if (!order) return { kind: "order_not_found" };

  const base = order.address ?? EMPTY_ADDRESS;
  const merged: ShippingAddressView = {
    name: f.name ?? base.name,
    address1: f.address1 ?? base.address1,
    address2: f.address2 ?? base.address2,
    city: f.city ?? base.city,
    province: f.province ?? base.province,
    country: f.country ?? base.country,
    zip: f.zip ?? base.zip,
    phone: f.phone ?? base.phone,
  };

  let stored: ShippingAddressView;
  try {
    stored = await opts.update({ orderId: order.orderId, address: merged });
  } catch (cause) {
    return {
      kind: "update_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  try {
    await opts.recordUpdated(stored);
  } catch (cause) {
    // The address already changed on the store — never report failure over
    // bookkeeping. Surface it in logs for follow-up.
    // eslint-disable-next-line no-console
    console.error("[edit shipping address] post-update bookkeeping failed", {
      cause,
    });
  }

  return { kind: "saved", address: stored };
};
