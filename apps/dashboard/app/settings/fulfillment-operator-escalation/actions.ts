"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";
import { extractGoogleSheetsSpreadsheetId } from "./sheet-url";

// A1 reference with mandatory sheet-name prefix (permissive on the column
// span). Forbids only the `!` separator inside the sheet name.
const RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

export const saveFulfillmentOperatorEscalationAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();

  const sheetUrlRaw = formData.get("sheetUrl") ?? formData.get("spreadsheetId");
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

  await api.setFulfillmentOperatorSheet(ctx, {
    spreadsheetId,
    range,
    description: description.length > 0 ? description : null,
  });

  revalidatePath("/settings/integrations/google_sheets");
  redirect("/settings/integrations/google_sheets?saved=1");
};

export const clearFulfillmentOperatorEscalationAction = async (): Promise<void> => {
  const ctx = await getDashboardContext();
  await api.clearFulfillmentOperatorSheet(ctx);
  revalidatePath("/settings/integrations/google_sheets");
  redirect("/settings/integrations/google_sheets?cleared=1");
};
