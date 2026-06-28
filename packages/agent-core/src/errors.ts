import { Data } from "effect";
import type { TenantId } from "./ids.js";
import type { ProviderName } from "./agent.js";

export class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: string;
}> {}

export class CustomerNotFound extends Data.TaggedError("CustomerNotFound")<{
  readonly query: string;
}> {}

export class ProductNotFound extends Data.TaggedError("ProductNotFound")<{
  readonly productId: string;
}> {}

/**
 * Shopify refused to create the refund. Common causes (from
 * `refundCreate.userErrors[].code`): no refundable transactions on the
 * order, amount exceeds the refundable maximum, currency mismatch with
 * the order, order already fully refunded. The `code` field is
 * Shopify's machine-readable hint when present; `message` is always
 * populated and surfaces to the operator via the audit log.
 */
export class RefundFailed extends Data.TaggedError("RefundFailed")<{
  readonly orderId: string;
  readonly code: string | null;
  readonly message: string;
}> {}

/**
 * Shopify refused to create the discount code. Common causes (from
 * `discountCodeBasicCreate.userErrors[].code`): a duplicate code, an
 * invalid value (e.g. percentage > 100), or a malformed customer
 * selection. The `code` field is Shopify's machine-readable hint when
 * present; `message` is always populated and surfaces to the operator
 * via the audit log. Mirrors `RefundFailed`'s shape so the tool boundary
 * handles both commercial-action failures the same way.
 */
export class DiscountFailed extends Data.TaggedError("DiscountFailed")<{
  readonly code: string | null;
  readonly message: string;
}> {}

/**
 * Shopify refused to cancel the order. Common causes (from
 * `orderCancel.orderCancelUserErrors[].code`): the order has already
 * shipped/been fulfilled, is already cancelled, or can't be refunded.
 * Mirrors `RefundFailed`'s shape (the cancel optionally refunds, so it's a
 * money action too) — `code` is Shopify's machine-readable hint when
 * present; `message` is always populated and surfaces to the operator via
 * the audit log.
 */
export class OrderCancelFailed extends Data.TaggedError("OrderCancelFailed")<{
  readonly orderId: string;
  readonly code: string | null;
  readonly message: string;
}> {}

export class ShopifyRateLimited extends Data.TaggedError("ShopifyRateLimited")<{
  readonly retryAfterMs: number;
}> {}

export class ShopifyAuthFailed extends Data.TaggedError("ShopifyAuthFailed")<{
  readonly tenantId: TenantId;
}> {}

export class ShopifyAuthMissing extends Data.TaggedError("ShopifyAuthMissing")<{
  readonly tenantId: TenantId;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly cause: unknown;
}> {}

export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly provider: ProviderName;
}> {}

export class ContextTooLarge extends Data.TaggedError("ContextTooLarge")<{
  readonly tokens: number;
  readonly limit: number;
}> {}

export class InvalidToolCall extends Data.TaggedError("InvalidToolCall")<{
  readonly tool: string;
  readonly issue: string;
}> {}

export class SafetyBlocked extends Data.TaggedError("SafetyBlocked")<{
  readonly reason: string;
}> {}

export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly tool: string;
  readonly reason: string;
}> {}

export class ToolOutputInvalid extends Data.TaggedError("ToolOutputInvalid")<{
  readonly tool: string;
  readonly issues: ReadonlyArray<string>;
}> {}

export class ConnectorNotFound extends Data.TaggedError("ConnectorNotFound")<{
  readonly tenantId: TenantId;
  readonly provider: string;
  readonly shopDomain: string | null;
}> {}

export class ConnectorRevoked extends Data.TaggedError("ConnectorRevoked")<{
  readonly tenantId: TenantId;
  readonly provider: string;
  readonly shopDomain: string | null;
}> {}

export class ConnectorStoreDbError extends Data.TaggedError(
  "ConnectorStoreDbError",
)<{
  readonly cause: unknown;
}> {}

export type ConnectorStoreError =
  | ConnectorNotFound
  | ConnectorRevoked
  | ConnectorStoreDbError;

export type ShopifyError =
  | OrderNotFound
  | CustomerNotFound
  | ProductNotFound
  | RefundFailed
  | DiscountFailed
  | OrderCancelFailed
  | ShopifyRateLimited
  | ShopifyAuthFailed
  | ShopifyAuthMissing
  | NetworkError;

export class LLMCredentialMissing extends Data.TaggedError(
  "LLMCredentialMissing",
)<{
  readonly tenantId: TenantId;
}> {}

export class LLMCredentialRevoked extends Data.TaggedError(
  "LLMCredentialRevoked",
)<{
  readonly tenantId: TenantId;
  readonly provider: string;
}> {}

export type LLMError =
  | ProviderUnavailable
  | ContextTooLarge
  | InvalidToolCall
  | SafetyBlocked
  | NetworkError
  | LLMCredentialMissing
  | LLMCredentialRevoked;

/**
 * Google Sheets connector errors. Same shape pattern as `ShopifyError` —
 * the Live impl maps HTTP failures into these tagged variants so the
 * tool / runtime boundary sees a stable error surface regardless of the
 * underlying transport.
 *
 *   - `SheetsAuthMissing`: no `google_sheets` row in `connector_connections`
 *     (the tenant never connected Sheets) OR the row exists but has no
 *     refresh token. Maps to `case → human_takeover` upstream.
 *   - `SheetsAuthFailed`: token refresh returned 401/403 (refresh token
 *     revoked from the merchant's Google account, or scopes withdrawn).
 *     Distinguished from `*Missing` so we can prompt the operator to
 *     reconnect rather than first-time-connect.
 *   - `SheetsNotFound`: the `spreadsheetId` or `range` doesn't resolve.
 *     Either the merchant pasted the wrong id or the sheet was deleted.
 *   - `SheetsAppendFailed`: catch-all write failure (rate limit, invalid
 *     range, malformed values) with the API message surfaced verbatim.
 *   - `SheetsReadFailed`: catch-all read failure (rate limit, invalid
 *     range, malformed response) when fetching the header row to align an
 *     append against the sheet's own column schema. Mirrors
 *     `SheetsAppendFailed` so reads and writes surface symmetrically.
 */
export class SheetsAuthMissing extends Data.TaggedError("SheetsAuthMissing")<{
  readonly tenantId: TenantId;
}> {}

export class SheetsAuthFailed extends Data.TaggedError("SheetsAuthFailed")<{
  readonly tenantId: TenantId;
}> {}

export class SheetsNotFound extends Data.TaggedError("SheetsNotFound")<{
  readonly spreadsheetId: string;
  readonly range: string;
}> {}

export class SheetsAppendFailed extends Data.TaggedError("SheetsAppendFailed")<{
  readonly spreadsheetId: string;
  readonly message: string;
}> {}

export class SheetsReadFailed extends Data.TaggedError("SheetsReadFailed")<{
  readonly spreadsheetId: string;
  readonly message: string;
}> {}

export type SheetsError =
  | SheetsAuthMissing
  | SheetsAuthFailed
  | SheetsNotFound
  | SheetsAppendFailed
  | SheetsReadFailed
  | NetworkError;

/**
 * Errors raised by the `TrackingService` Live implementation. Note that
 * "no upstream provider configured" is NOT an error — that case maps to
 * `TrackingLookup.kind === "no_provider"` in the success channel so
 * agents can branch on it in their prompt without dealing with a typed
 * failure. The errors below are only for genuine provider problems
 * (network, upstream 5xx, rate limit).
 */
export class TrackingProviderUnavailable extends Data.TaggedError(
  "TrackingProviderUnavailable",
)<{
  readonly trackingNumber: string;
  readonly message: string;
}> {}

export class TrackingProviderRateLimited extends Data.TaggedError(
  "TrackingProviderRateLimited",
)<{
  readonly retryAfterMs: number;
}> {}

export type TrackingError =
  | TrackingProviderUnavailable
  | TrackingProviderRateLimited
  | NetworkError;

/**
 * BlobStorage errors. Backs the `BlobStorage` Tag which abstracts the
 * platform's binary-blob store (Cloudflare R2 in production, in-memory
 * test layer in unit tests, local fs in dev when `BLOB_STORAGE_DIR` is
 * set).
 *
 *   - `BlobNotFound`: a `get` / `presignGetUrl` lookup hit no object
 *     under the supplied key. Distinct from `BlobStorageFailed` so the
 *     LLM service can treat a missing image attachment as an upstream
 *     "provider unavailable" rather than a generic network error.
 *   - `BlobStorageFailed`: catch-all for transport / S3 API failures
 *     (rate limit, malformed bucket config, auth). The Live impl
 *     surfaces the underlying cause for diagnostics.
 */
export class BlobNotFound extends Data.TaggedError("BlobNotFound")<{
  readonly key: string;
}> {}

export class BlobStorageFailed extends Data.TaggedError("BlobStorageFailed")<{
  readonly key: string | null;
  readonly cause: unknown;
}> {}

export type BlobStorageError = BlobNotFound | BlobStorageFailed;

export type ToolError =
  | PermissionDenied
  | ToolOutputInvalid
  | NetworkError
  | LLMError
  | ShopifyError
  | SheetsError
  | TrackingError;
