"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

import { parseValidityDays, resolveDiscountThresholds } from "./parse-discount";

export const saveDiscountPolicyAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const currencyRaw = formData.get("currencyCode");
  const currency =
    typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    redirect("/settings/discount-policy?error=bad_currency");
  }

  const validityRaw = formData.get("maxValidityDays");
  const days = parseValidityDays(
    typeof validityRaw === "string" ? validityRaw : "",
  );
  if (days === null) {
    redirect("/settings/discount-policy?error=bad_validity");
  }

  const modeRaw = formData.get("mode");
  const mode =
    modeRaw === "always_ask" || modeRaw === "always_deny"
      ? modeRaw
      : "thresholds";

  const str = (key: string): string => {
    const v = formData.get(key);
    return typeof v === "string" ? v : "";
  };

  // Dormant thresholds fall back PER FIELD to the stored value so a stale tab
  // can't silently zero saved numbers (same U10 guard as refunds).
  const { discountPolicy: stored } = await api.settings(ctx);
  const resolved = resolveDiscountThresholds({
    mode,
    askPctRaw: str("askAbovePercentage"),
    maxPctRaw: str("maxPercentage"),
    askAmtRaw: str("askAboveFixedAmount"),
    maxAmtRaw: str("maxFixedAmount"),
    stored: {
      askPct: stored.askAbovePercentage,
      maxPct: stored.maxPercentage,
      askMinor: stored.askAboveFixedAmountMinorUnits,
      maxMinor: stored.maxFixedAmountMinorUnits,
    },
  });
  if (!resolved.ok) {
    redirect(`/settings/discount-policy?error=${resolved.error}`);
  }

  await api.setDiscountPolicy(ctx, {
    currencyCode: currency,
    askAbovePercentage: resolved.askPct,
    maxPercentage: resolved.maxPct,
    askAboveFixedAmountMinorUnits: resolved.askMinor,
    maxFixedAmountMinorUnits: resolved.maxMinor,
    maxValidityDays: days,
    mode,
  });

  revalidatePath("/settings/discount-policy");
  redirect("/settings/discount-policy?saved=1");
};
