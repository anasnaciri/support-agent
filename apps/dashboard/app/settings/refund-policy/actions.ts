"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Effect, Layer } from "effect";
import { DbClientLive, TenantRepositoryLive } from "@support-agent/db";
import { TenantRepository } from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { getTenantId } from "@/lib/tenant";

const tenantRepoLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = DbClientLive({ databaseUrl });
  return TenantRepositoryLive.pipe(Layer.provide(db));
};

/**
 * Parse a major-units decimal string ("25.00", "200") into minor units
 * (2500, 20000). Returns null on malformed input. Trims surrounding
 * whitespace; rejects negative values, multiple dots, and inputs with
 * more than 2 fractional digits (we don't support sub-cent thresholds).
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
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  const currencyRaw = formData.get("currencyCode");
  const askRaw = formData.get("askAbove");
  const denyRaw = formData.get("denyAbove");

  const currency = typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
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
  // Validate ordering: askAbove must not exceed denyAbove, otherwise
  // there's no `ask` zone — every refund either auto-allows or denies.
  // Allow ask == deny (degenerate but legal: everything above askAbove
  // is denied with no human-approval window).
  if (askMinor > denyMinor) {
    redirect("/settings/refund-policy?error=bad_order");
  }

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setRefundPolicy(tid, {
          askAboveMinorUnits: askMinor,
          denyAboveMinorUnits: denyMinor,
          currencyCode: currency,
        });
      }),
      tenantRepoLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/refund-policy");
  redirect("/settings/refund-policy?saved=1");
};
