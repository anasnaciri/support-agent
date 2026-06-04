"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

/**
 * Parse a major-units decimal string ("25.00", "200") into minor units
 * (2500, 20000). Returns null on malformed input. Rejects negatives, multiple
 * dots, and more than 2 fractional digits (no sub-cent thresholds).
 */
const parseMajorUnits = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
};

export const saveRefundPolicyAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const currencyRaw = formData.get("currencyCode");
  const askRaw = formData.get("askAbove");
  const denyRaw = formData.get("denyAbove");

  const currency =
    typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
  const ask = typeof askRaw === "string" ? askRaw : "";
  const deny = typeof denyRaw === "string" ? denyRaw : "";

  if (!/^[A-Z]{3}$/.test(currency)) {
    redirect("/settings/refund-policy?error=bad_currency");
  }
  const askMinor = parseMajorUnits(ask);
  const denyMinor = parseMajorUnits(deny);
  if (askMinor === null || denyMinor === null) {
    redirect("/settings/refund-policy?error=bad_amount");
  }
  if (askMinor > denyMinor) {
    redirect("/settings/refund-policy?error=bad_order");
  }

  await api.setRefundPolicy(ctx, {
    currencyCode: currency,
    askAboveMinorUnits: askMinor,
    denyAboveMinorUnits: denyMinor,
  });

  revalidatePath("/settings/refund-policy");
  redirect("/settings/refund-policy?saved=1");
};
