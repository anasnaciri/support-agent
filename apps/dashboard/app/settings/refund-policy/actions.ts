"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

import { resolveRefundThresholds } from "./parse-thresholds";

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
  const modeRaw = formData.get("mode");
  const mode =
    modeRaw === "always_ask" || modeRaw === "always_deny"
      ? modeRaw
      : "thresholds";

  if (!/^[A-Z]{3}$/.test(currency)) {
    redirect("/settings/refund-policy?error=bad_currency");
  }

  // In `thresholds` mode both amounts govern behaviour and must validate. In
  // always-ask / always-deny they're dormant: a parseable value is persisted
  // (so switching back restores it), but an unparseable one falls back to the
  // STORED value — never coalesced to 0, so a stale tab can't silently zero
  // the merchant's saved thresholds (U10).
  const { refundPolicy: stored } = await api.settings(ctx);
  const resolved = resolveRefundThresholds({
    mode,
    askRaw: ask,
    denyRaw: deny,
    stored: {
      askMinor: stored.askAboveMinorUnits,
      denyMinor: stored.denyAboveMinorUnits,
    },
  });
  if (!resolved.ok) {
    redirect(`/settings/refund-policy?error=${resolved.error}`);
  }

  await api.setRefundPolicy(ctx, {
    currencyCode: currency,
    askAboveMinorUnits: resolved.askMinor,
    denyAboveMinorUnits: resolved.denyMinor,
    mode,
  });

  revalidatePath("/settings/refund-policy");
  redirect("/settings/refund-policy?saved=1");
};

/**
 * Toggle whether `order.cancel` returns the cancelled order's items to
 * inventory. Submitted on change by the restock checkbox (no Save button); the
 * page revalidates in place. A checkbox sends "on" when checked and is absent
 * when unchecked.
 */
export const saveCancellationRestockAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const restock = formData.get("restock") === "on";
  await api.setCancellationRestock(ctx, restock);
  revalidatePath("/settings/refund-policy");
};
