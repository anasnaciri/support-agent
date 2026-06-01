import { redirect } from "next/navigation";

/**
 * The supplier-escalation sheet target now lives on the Google Sheets
 * connector page — it's a property of that connection, not a standalone
 * setting. Keep this route as a permanent redirect so old links / bookmarks
 * still land on the form.
 */
export default function SupplierEscalationRedirect() {
  redirect("/settings/integrations/google_sheets");
}
