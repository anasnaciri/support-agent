"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Effect, Layer } from "effect";
import { DbClientLive, TenantRepositoryLive } from "@support-agent/db";
import { TenantRepository } from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { getTenantId } from "@/lib/tenant";
import { extractGoogleSheetsSpreadsheetId } from "./sheet-url";

const tenantRepoLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = DbClientLive({ databaseUrl });
  return TenantRepositoryLive.pipe(Layer.provide(db));
};

// A1 reference with mandatory sheet-name prefix. Permissive: column
// span can be a single letter (`Escalations!A:A`), a range
// (`Escalations!A:F`), or a numbered window (`Escalations!A1:F100`).
// The sheet name itself can include spaces / unicode — only forbid the
// `!` separator inside it.
const RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

export const saveSupplierEscalationAction = async (
  formData: FormData,
): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  const sheetUrlRaw =
    formData.get("sheetUrl") ?? formData.get("spreadsheetId");
  const rangeRaw = formData.get("range");
  const descriptionRaw = formData.get("description");

  const sheetUrl = typeof sheetUrlRaw === "string" ? sheetUrlRaw.trim() : "";
  const spreadsheetId = extractGoogleSheetsSpreadsheetId(sheetUrl);
  const range = typeof rangeRaw === "string" ? rangeRaw.trim() : "";
  const description =
    typeof descriptionRaw === "string" ? descriptionRaw.trim() : "";

  if (sheetUrl.length === 0) {
    redirect("/settings/integrations/google_sheets?error=missing_sheet_url");
  }
  if (!spreadsheetId) {
    redirect("/settings/integrations/google_sheets?error=bad_sheet_url");
  }
  if (!RANGE_RE.test(range)) {
    redirect("/settings/integrations/google_sheets?error=bad_range");
  }

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(tid, {
          spreadsheetId,
          range,
          description: description.length > 0 ? description : null,
        });
      }),
      tenantRepoLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/integrations/google_sheets");
  redirect("/settings/integrations/google_sheets?saved=1");
};

export const clearSupplierEscalationAction = async (): Promise<void> => {
  const tenantId = await getTenantId();
  const tid = TenantId(tenantId);

  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        yield* repo.setSupplierEscalationSheet(tid, null);
      }),
      tenantRepoLayer(),
    ).pipe(Effect.scoped),
  );

  revalidatePath("/settings/integrations/google_sheets");
  redirect("/settings/integrations/google_sheets?cleared=1");
};
