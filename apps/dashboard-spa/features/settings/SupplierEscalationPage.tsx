import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList } from "lucide-react";
import { toast } from "sonner";

import type { SupplierEscalationSheetView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  extractGoogleSheetsSpreadsheetId,
  googleSheetsUrlForSpreadsheetId,
} from "@/lib/sheet-url";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

// A1 reference with mandatory sheet-name prefix (permissive on the column
// span). Forbids only the `!` separator inside the sheet name. Mirrors the Next
// action's RANGE_RE — the same check the server ran before persisting.
const RANGE_RE = /^[^!]+![A-Z]+\d*(:[A-Z]+\d*)?$/;

// The Next action surfaced these via post-redirect-get feedback rules
// (SHEETS_FEEDBACK); here we toast the identical strings directly — the
// client-side validation guards for the checks the server ran, and the
// mutation callbacks for the write outcomes.
const MISSING_SHEET_URL_MSG = "Google Sheets URL is required.";
const BAD_SHEET_URL_MSG =
  "Paste the URL from a Google Sheet, for example https://docs.google.com/spreadsheets/d/.../edit.";
const BAD_RANGE_MSG =
  "Range must be an A1 reference with a sheet name (e.g. Escalations!A:F).";
const SAVED_MSG = "Sheet target saved.";
const CLEARED_MSG =
  "Sheet target cleared. The agent will skip the sheet write on future missing-package tickets.";
const GENERIC_ERROR_MSG = "Something went wrong. Please try again.";

// The sheet-target form is a controlled component because the Clear button is
// only offered once a target is saved, and the fields are seeded from the
// stored target. State is initialised from the loaded settings row (like the
// Next form's defaultValue props).
function SheetTargetForm({
  sheet,
  sheetsActive,
}: {
  readonly sheet: SupplierEscalationSheetView | null;
  readonly sheetsActive: boolean;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  const [sheetUrl, setSheetUrl] = useState(
    sheet ? googleSheetsUrlForSpreadsheetId(sheet.spreadsheetId) : "",
  );
  const [range, setRange] = useState(sheet?.range ?? "Escalations!A:F");
  const [description, setDescription] = useState(sheet?.description ?? "");

  const save = useMutation({
    mutationFn: (input: {
      readonly spreadsheetId: string;
      readonly range: string;
      readonly description: string | null;
    }) => api.setSupplierSheet(ctx, input),
    onSuccess: () => {
      toast.success(SAVED_MSG);
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => toast.warning(GENERIC_ERROR_MSG),
  });

  const clear = useMutation({
    mutationFn: () => api.clearSupplierSheet(ctx),
    onSuccess: () => {
      toast(CLEARED_MSG);
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => toast.warning(GENERIC_ERROR_MSG),
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Same validation order the server action ran before persisting.
    const trimmedUrl = sheetUrl.trim();
    if (trimmedUrl.length === 0) {
      toast.warning(MISSING_SHEET_URL_MSG);
      return;
    }
    const spreadsheetId = extractGoogleSheetsSpreadsheetId(trimmedUrl);
    if (!spreadsheetId) {
      toast.warning(BAD_SHEET_URL_MSG);
      return;
    }
    const trimmedRange = range.trim();
    if (!RANGE_RE.test(trimmedRange)) {
      toast.warning(BAD_RANGE_MSG);
      return;
    }
    const trimmedDescription = description.trim();

    save.mutate({
      spreadsheetId,
      range: trimmedRange,
      description: trimmedDescription.length > 0 ? trimmedDescription : null,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="size-4" aria-hidden />
          Sheet target
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <p className="text-sm text-muted-foreground">
          The Google Sheet the missing-package agent writes to via{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            supplier.add_sheet_row
          </code>{" "}
          when a customer reports a package marked delivered that didn&apos;t
          arrive (BRANCH A). The platform writes rows using this connection.
          Leave unset to skip the sheet write entirely.
        </p>

        {!sheetsActive ? (
          <Alert variant="warning">
            <AlertTriangle className="size-4" />
            <AlertTitle>Connect Google Sheets first</AlertTitle>
            <AlertDescription>
              You can save a target below, but the agent can only write once this
              connection is active.
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2 sm:max-w-2xl">
            <Label htmlFor="sheetUrl">Google Sheets URL</Label>
            <Input
              id="sheetUrl"
              name="sheetUrl"
              type="text"
              inputMode="url"
              autoComplete="off"
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/.../edit"
              required
              aria-describedby="sheet-url-hint"
            />
            <p id="sheet-url-hint" className="text-xs text-muted-foreground">
              Open the Google Sheet and paste the link from the browser address
              bar. The platform extracts the sheet ID automatically.
            </p>
          </div>

          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="range">Range</Label>
            <Input
              id="range"
              name="range"
              type="text"
              inputMode="text"
              autoComplete="off"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              required
              aria-describedby="range-hint"
            />
            <p id="range-hint" className="text-xs text-muted-foreground">
              A1 reference with sheet name. The agent appends below the last
              non-empty row inside this column span.
            </p>
          </div>

          <div className="grid gap-2 sm:max-w-2xl">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              name="description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Warehouse ops watches this sheet for delivery exceptions."
            />
            <p className="text-xs text-muted-foreground">
              For your team. Not surfaced to the agent or written to the sheet.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {sheet ? (
              <Button
                type="button"
                variant="outline"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
              >
                {clear.isPending ? "Clearing…" : "Clear"}
              </Button>
            ) : null}
          </div>
        </form>

        <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">
            Columns are yours — the agent reads your header row
          </p>
          <p className="mb-2">
            You don&apos;t need a fixed layout. When the missing-package agent
            escalates, it reads the sheet&apos;s header row and fills the columns
            it recognises by name, leaving the rest blank. Add a header row with
            any of these (in any order); the agent matches them
            case-insensitively:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Ticket</strong> / Ticket ID / Ticket — the support ticket id
            </li>
            <li>
              <strong>Email</strong> / Customer — the customer&apos;s email
            </li>
            <li>
              <strong>Order</strong> / Order # — the order name (e.g. #1001)
            </li>
            <li>
              <strong>Tracking</strong> — the carrier tracking number
            </li>
            <li>
              <strong>Delivered</strong> / Delivered At — the delivered-at
              timestamp
            </li>
            <li>
              <strong>Date</strong> / Logged / Reported — when the row was logged
            </li>
          </ul>
          <p className="mt-2">
            No header row? The agent falls back to that order, left-to-right.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function SupplierEscalationPage() {
  const ctx = useWorkspaceCtx();
  const allowed = useRequirePermission("settings.integrations");

  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  const connectionsQuery = useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const settings = settingsQuery.data;
  const sheet = settings?.supplierEscalationSheet ?? null;
  // The Google Sheets connector owns the sheet target the agent writes to. It's
  // usable only while that connection is active — otherwise we let the merchant
  // save a target but warn the agent can't write yet.
  const sheetsRow =
    (connectionsQuery.data ?? []).find((c) => c.provider === "google_sheets") ??
    null;
  const sheetsActive = sheetsRow?.status === "active";

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/integrations", label: "Integrations" }]}
        current="Supplier escalation"
      />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Supplier escalation
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Point the missing-package agent at a Google Sheet to log delivery
          exceptions your warehouse or supplier ops team can action.
        </p>
      </div>

      {!settings || connectionsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <SheetTargetForm sheet={sheet} sheetsActive={sheetsActive} />
      )}
    </div>
  );
}
