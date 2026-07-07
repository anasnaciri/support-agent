// ============================================================
// JSON Schemas for apps/api routes
// ============================================================
//
// These power three things at once on each Fastify route:
//   1. request validation (querystring / params),
//   2. response serialization (fast-json-stringify on the success path),
//   3. OpenAPI generation (@fastify/swagger reads the same schemas).
//
// Two rules keep these schemas from changing any externally-observable
// behavior the integration test pins:
//
//   • Input schemas are *permissive* — every field optional, all of them
//     `string`, `additionalProperties: true`. The handlers still own the
//     real conditional validation (shop optional, tenant optional with an
//     HMAC + cookie fallback, …), so schema validation never pre-empts a
//     handler's bespoke 400 / 401 / 409 body.
//   • Response schemas declare known fields but stay
//     `additionalProperties: true`, so route-specific extras (`shop`,
//     `detail`, `missing`, `matchedTickets`, …) serialize through unchanged
//     instead of being stripped by fast-json-stringify.
//
// Routes whose success body is HTML or plain text (`/installed`,
// `/approvals/*`, `/healthz`) get no response schema at all — a JSON
// serializer would mangle their payloads.

export const TAGS = [
  {
    name: "shopify",
    description: "Shopify OAuth install, callback, and lifecycle webhooks",
  },
  { name: "google", description: "Google / Gmail OAuth install and callback" },
  { name: "webhooks", description: "Inbound provider push webhooks" },
  { name: "approvals", description: "One-click approval-link decisions" },
  { name: "dashboard", description: "Tenant-scoped read API for the dashboard" },
  { name: "system", description: "Health and service metadata" },
];

// ------------------------------------------------------------
// Shared response bodies
// ------------------------------------------------------------

/**
 * Every error body in this service is `{ error: string, ...extras }`.
 * `additionalProperties: true` lets the per-route extras (`shop`,
 * `detail`, `missing`, `receivedParamNames`, `shopifyError`, …) pass
 * through the serializer untouched, so attaching this to the `4xx`/`5xx`
 * ranges documents errors without rewriting any response shape.
 */
export const errorResponseSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: true,
};

const appUninstalledWebhookSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    topic: { type: "string" },
    uri: { type: "string" },
    status: { type: "string" },
  },
  additionalProperties: true,
};

export const shopifyCallbackSuccessSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    tenantId: { type: "string" },
    shop: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    ownershipTransferred: { type: "boolean" },
    appUninstalledWebhook: appUninstalledWebhookSchema,
  },
  additionalProperties: true,
};

export const googleCallbackSuccessSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    tenantId: { type: "string" },
    provider: { type: "string" },
    email: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    watchRegistered: { type: "boolean" },
  },
  // `unreadBackfill` is an object|null left undeclared on purpose; the
  // parent's additionalProperties:true serializes it generically.
  additionalProperties: true,
};

/** `{ ok: true, action?: string, ...extras }` — Shopify + Gmail webhook acks. */
export const webhookAckSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    action: { type: "string" },
  },
  additionalProperties: true,
};

// ------------------------------------------------------------
// Request inputs (documentation + permissive validation)
// ------------------------------------------------------------

export const shopifyInstallQuerySchema = {
  type: "object",
  properties: {
    shop: { type: "string" },
    tenant: { type: "string" },
    hmac: { type: "string" },
    host: { type: "string" },
    timestamp: { type: "string" },
  },
  additionalProperties: true,
};

export const shopifyCallbackQuerySchema = {
  type: "object",
  properties: {
    shop: { type: "string" },
    code: { type: "string" },
    state: { type: "string" },
    hmac: { type: "string" },
    host: { type: "string" },
    timestamp: { type: "string" },
    error: { type: "string" },
    error_description: { type: "string" },
  },
  additionalProperties: true,
};

export const installedQuerySchema = {
  type: "object",
  properties: {
    shop: { type: "string" },
    host: { type: "string" },
    email: { type: "string" },
    provider: { type: "string" },
  },
  additionalProperties: true,
};

export const googleInstallQuerySchema = {
  type: "object",
  properties: {
    tenant: { type: "string" },
    provider: { type: "string" },
    connector: { type: "string" },
    login_hint: { type: "string" },
    loginHint: { type: "string" },
  },
  additionalProperties: true,
};

export const googleCallbackQuerySchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    state: { type: "string" },
    error: { type: "string" },
    error_description: { type: "string" },
  },
  additionalProperties: true,
};

export const tokenQuerySchema = {
  type: "object",
  properties: { token: { type: "string" } },
  additionalProperties: true,
};

export const gmailParamsSchema = {
  type: "object",
  properties: { tenantId: { type: "string" } },
  additionalProperties: false,
};

export const approvalParamsSchema = {
  type: "object",
  properties: {
    approvalId: { type: "string" },
    action: { type: "string" },
  },
  additionalProperties: false,
};

export const bundleReviewParamsSchema = {
  type: "object",
  properties: { ticketId: { type: "string" } },
  additionalProperties: false,
};

export const bundleDecisionParamsSchema = {
  type: "object",
  properties: {
    ticketId: { type: "string" },
    action: { type: "string" },
  },
  additionalProperties: false,
};
