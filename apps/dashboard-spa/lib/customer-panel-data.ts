import type { ShopifyCustomer } from "@support-agent/agent-core";

import { asDate } from "./format";

// Pure helpers for CustomerPanel. Extracted so the money/date shaping the
// stat cards render is unit-tested against the shapes the data ACTUALLY has at
// runtime — the dashboard reads customers through apps/api over JSON (Path B),
// so `createdAt` arrives as an ISO *string* even though the domain type says
// `Date`; `asDate` coerces before `.getFullYear()`.

/**
 * Format a decimal money string compactly for a stat card: strip a whole
 * `.00` tail, add thousands separators, keep real cents. `"1240.00"` → `"1,240"`,
 * `"12.50"` → `"12.50"`. Falls back to the raw string when it isn't a finite
 * number so a surprising value shows rather than `NaN`.
 */
export const formatMoneyAmount = (amount: string): string => {
  const n = Number(amount);
  if (amount.trim() === "" || !Number.isFinite(n)) return amount;
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
};

export interface CustomerStat {
  readonly label: string;
  readonly value: string;
  /** Small trailing unit (e.g. currency code), or null for a bare number. */
  readonly hint: string | null;
}

/**
 * The three at-a-glance customer stats shown as mono-number cards atop the
 * details column: lifetime spend, order count, and the year they became a
 * customer.
 */
export const customerStats = (
  customer: ShopifyCustomer,
): readonly CustomerStat[] => [
  {
    label: "Lifetime",
    value: formatMoneyAmount(customer.totalSpent.amount),
    hint: customer.totalSpent.currencyCode,
  },
  { label: "Orders", value: String(customer.ordersCount), hint: null },
  {
    label: "Since",
    value: String(asDate(customer.createdAt).getFullYear()),
    hint: null,
  },
];
