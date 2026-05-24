import { Data } from "effect";
import type { TenantId } from "./ids.js";
import type { ProviderName } from "./agent.js";

export class OrderNotFound extends Data.TaggedError("OrderNotFound")<{
  readonly orderId: string;
}> {}

export class CustomerNotFound extends Data.TaggedError("CustomerNotFound")<{
  readonly query: string;
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
  | RefundFailed
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

export type ToolError =
  | PermissionDenied
  | ToolOutputInvalid
  | NetworkError
  | LLMError
  | ShopifyError;
