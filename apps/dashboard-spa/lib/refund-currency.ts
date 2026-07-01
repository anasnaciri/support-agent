import type { RefundPolicyMode } from "@support-agent/dashboard-contracts";

/**
 * Whether to warn that the refund-policy currency doesn't match the Shopify
 * store's currency. Only meaningful in `thresholds` mode — the amount zones
 * are denominated in the policy currency, so a store charging in a different
 * currency would have every refund treated as cross-currency and pause for
 * approval. In always_ask / always_deny the amount (and thus currency) is
 * irrelevant, so we never warn. An unknown store currency (null/empty —
 * lookup failed or no Shopify connection) never warns either.
 */
export const refundCurrencyMismatch = (
  policyCurrency: string,
  storeCurrency: string | null,
  mode: RefundPolicyMode,
): boolean => {
  if (mode !== "thresholds") return false;
  const store = storeCurrency?.trim().toUpperCase();
  if (!store) return false;
  return policyCurrency.trim().toUpperCase() !== store;
};
