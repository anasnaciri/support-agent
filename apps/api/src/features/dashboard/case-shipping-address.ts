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
// address, but the pencil form is a per-field edit. So each field is
// three-state: `undefined` = keep the order's current value, `null` = clear
// it, a string = replace it. The merged full address is what gets written —
// an operator fixing the ZIP doesn't wipe the street, and blanking the
// prefilled "Apartment" field genuinely removes it from the address.

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

/**
 * The submitted correction. Absent = keep the current value; `null` = clear
 * it; a string = replace it.
 */
export interface ShippingAddressEditFields {
  readonly name?: string | null;
  readonly address1?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly country?: string | null;
  readonly zip?: string | null;
  readonly phone?: string | null;
}

const FIELD_NAMES = [
  "name",
  "address1",
  "address2",
  "city",
  "province",
  "country",
  "zip",
  "phone",
] as const;

/**
 * Map a JSON body to edit fields: an absent or non-string value = keep (the
 * form always posts strings), a blank string = clear, text = set (trimmed).
 * The full-form pencil posts EVERY field as a string, so blanking a prefilled
 * input is how the operator clears it.
 */
export const parseShippingAddressFields = (
  body: Record<string, unknown>,
): ShippingAddressEditFields => {
  const out: Record<string, string | null> = {};
  for (const name of FIELD_NAMES) {
    const raw = body[name];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    out[name] = trimmed.length > 0 ? trimmed : null;
  }
  return out;
};

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
  // Three-state per field: undefined keeps, null clears, a string replaces.
  const merged: ShippingAddressView = {
    name: f.name === undefined ? base.name : f.name,
    address1: f.address1 === undefined ? base.address1 : f.address1,
    address2: f.address2 === undefined ? base.address2 : f.address2,
    city: f.city === undefined ? base.city : f.city,
    province: f.province === undefined ? base.province : f.province,
    country: f.country === undefined ? base.country : f.country,
    zip: f.zip === undefined ? base.zip : f.zip,
    phone: f.phone === undefined ? base.phone : f.phone,
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
