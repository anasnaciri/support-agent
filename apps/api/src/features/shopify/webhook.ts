// ============================================================
// app/uninstalled payload
// ============================================================
//
// Raw request bytes are captured by Fastify's buffer content-type parser
// (`apps/api/src/server.ts`), not here — webhook HMAC is verified over
// those exact bytes before any of the parsers below run.

/**
 * Shopify ships uninstall payloads roughly as:
 *
 *   { "id": 12345, "name": "acme.myshopify.com", "domain": "acme.com", ... }
 *
 * We trust the `X-Shopify-Shop-Domain` header for the shop domain (it's
 * inside the HMAC envelope) and use the body as a cross-check. Returning a
 * typed shape keeps the route handler from touching `unknown`.
 */
export interface UninstallPayload {
  readonly id: number | null;
  readonly name: string | null;
  readonly domain: string | null;
}

export interface FulfillmentShipmentPayload {
  readonly sourceOrderId: string;
  readonly sourceFulfillmentId: string;
  readonly trackingNumber: string;
  readonly carrier: string | null;
  readonly shippedAt: Date | null;
}

export const parseFulfillmentShipmentPayload = (
  buf: Buffer,
): ReadonlyArray<FulfillmentShipmentPayload> => {
  const raw = safeJson(buf);
  if (!raw) return [];
  const fulfillmentId = raw["id"];
  const orderId = raw["order_id"];
  if (
    (typeof fulfillmentId !== "number" &&
      typeof fulfillmentId !== "string") ||
    (typeof orderId !== "number" && typeof orderId !== "string")
  ) {
    return [];
  }
  const values = Array.isArray(raw["tracking_numbers"])
    ? raw["tracking_numbers"]
    : typeof raw["tracking_number"] === "string"
      ? [raw["tracking_number"]]
      : [];
  const trackingNumbers = [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const shippedAtRaw =
    typeof raw["created_at"] === "string" ? raw["created_at"] : null;
  const shippedAt = shippedAtRaw ? new Date(shippedAtRaw) : null;
  return trackingNumbers.map((trackingNumber) => ({
    sourceOrderId: `gid://shopify/Order/${orderId}`,
    sourceFulfillmentId: `gid://shopify/Fulfillment/${fulfillmentId}`,
    trackingNumber,
    carrier:
      typeof raw["tracking_company"] === "string"
        ? raw["tracking_company"]
        : null,
    shippedAt:
      shippedAt && !Number.isNaN(shippedAt.getTime()) ? shippedAt : null,
  }));
};

export const parseUninstallPayload = (buf: Buffer): UninstallPayload => {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    return { id: null, name: null, domain: null };
  }
  if (typeof raw !== "object" || raw === null) {
    return { id: null, name: null, domain: null };
  }
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r["id"] === "number" ? r["id"] : null,
    name: typeof r["name"] === "string" ? r["name"] : null,
    domain: typeof r["domain"] === "string" ? r["domain"] : null,
  };
};

// ============================================================
// Compliance webhook payloads
// ============================================================
//
// All three follow Shopify's documented shapes. We surface only the
// fields we operationally need; everything else is preserved in the raw
// body that callers can stash for the audit-trail.
//
// Common: `shop_id` is a numeric, `shop_domain` is the `.myshopify.com`
// string. The HMAC envelope authenticates both, so we trust them.

export interface CustomersDataRequestPayload {
  readonly shopId: number | null;
  readonly shopDomain: string | null;
  readonly customer: {
    readonly id: number | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
  readonly ordersRequested: ReadonlyArray<number>;
  readonly dataRequestId: number | null;
}

export interface CustomersRedactPayload {
  readonly shopId: number | null;
  readonly shopDomain: string | null;
  readonly customer: {
    readonly id: number | null;
    readonly email: string | null;
    readonly phone: string | null;
  };
  readonly ordersToRedact: ReadonlyArray<number>;
}

export interface ShopRedactPayload {
  readonly shopId: number | null;
  readonly shopDomain: string | null;
}

const safeJson = (buf: Buffer): Record<string, unknown> | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : null;
};

const parseCustomerSubObject = (
  r: Record<string, unknown>,
): CustomersDataRequestPayload["customer"] => {
  const c = (r["customer"] ?? {}) as Record<string, unknown>;
  return {
    id: typeof c["id"] === "number" ? c["id"] : null,
    email: typeof c["email"] === "string" ? c["email"] : null,
    phone: typeof c["phone"] === "string" ? c["phone"] : null,
  };
};

const parseNumberArray = (raw: unknown): ReadonlyArray<number> =>
  Array.isArray(raw)
    ? raw.filter((n): n is number => typeof n === "number")
    : [];

export const parseCustomersDataRequest = (
  buf: Buffer,
): CustomersDataRequestPayload => {
  const r = safeJson(buf);
  if (!r) {
    return {
      shopId: null,
      shopDomain: null,
      customer: { id: null, email: null, phone: null },
      ordersRequested: [],
      dataRequestId: null,
    };
  }
  const dr = (r["data_request"] ?? {}) as Record<string, unknown>;
  return {
    shopId: typeof r["shop_id"] === "number" ? r["shop_id"] : null,
    shopDomain:
      typeof r["shop_domain"] === "string" ? r["shop_domain"] : null,
    customer: parseCustomerSubObject(r),
    ordersRequested: parseNumberArray(r["orders_requested"]),
    dataRequestId: typeof dr["id"] === "number" ? dr["id"] : null,
  };
};

export const parseCustomersRedact = (
  buf: Buffer,
): CustomersRedactPayload => {
  const r = safeJson(buf);
  if (!r) {
    return {
      shopId: null,
      shopDomain: null,
      customer: { id: null, email: null, phone: null },
      ordersToRedact: [],
    };
  }
  return {
    shopId: typeof r["shop_id"] === "number" ? r["shop_id"] : null,
    shopDomain:
      typeof r["shop_domain"] === "string" ? r["shop_domain"] : null,
    customer: parseCustomerSubObject(r),
    ordersToRedact: parseNumberArray(r["orders_to_redact"]),
  };
};

export const parseShopRedact = (buf: Buffer): ShopRedactPayload => {
  const r = safeJson(buf);
  if (!r) {
    return { shopId: null, shopDomain: null };
  }
  return {
    shopId: typeof r["shop_id"] === "number" ? r["shop_id"] : null,
    shopDomain:
      typeof r["shop_domain"] === "string" ? r["shop_domain"] : null,
  };
};
