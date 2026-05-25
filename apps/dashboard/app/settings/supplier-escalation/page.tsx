import { Effect, Layer } from "effect";
import { ClipboardList } from "lucide-react";

import { DbClientLive, TenantRepositoryLive } from "@support-agent/db";
import {
  TenantRepository,
  defaultRefundPolicy,
  DEFAULT_RETENTION_DAYS,
  TenantSettings,
  type SupplierEscalationSheet,
} from "@support-agent/services";
import { TenantId } from "@support-agent/agent-core";
import { getTenantId } from "@/lib/tenant";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import {
  clearSupplierEscalationAction,
  saveSupplierEscalationAction,
} from "./actions";

const tenantRepoLayer = () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = DbClientLive({ databaseUrl });
  return TenantRepositoryLive.pipe(Layer.provide(db));
};

const loadSheet = async (
  tenantId: string,
): Promise<SupplierEscalationSheet | null> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const repo = yield* TenantRepository;
        const settings = yield* repo.getSettings(TenantId(tenantId)).pipe(
          Effect.catchAll(() =>
            Effect.succeed(
              new TenantSettings({
                notificationEmail: null,
                refundPolicy: defaultRefundPolicy,
                retentionDays: DEFAULT_RETENTION_DAYS,
                supplierEscalationSheet: null,
              }),
            ),
          ),
        );
        return settings.supplierEscalationSheet;
      }),
      tenantRepoLayer(),
    ).pipe(Effect.scoped),
  );

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function SupplierEscalationPage({
  searchParams,
}: PageProps) {
  const tenantId = await getTenantId();
  const sheet = await loadSheet(tenantId);
  const params = (await searchParams) ?? {};

  const savedBanner =
    (Array.isArray(params["saved"]) ? params["saved"][0] : params["saved"]) ===
    "1";
  const clearedBanner =
    (Array.isArray(params["cleared"])
      ? params["cleared"][0]
      : params["cleared"]) === "1";
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Supplier escalation" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Supplier escalation
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A shared Google Sheets target for the{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            supplier.add_sheet_row
          </code>{" "}
          tool. When configured, the missing-package agent logs a row
          here whenever a customer reports a package marked delivered
          that didn't arrive (BRANCH A). When unset, the agent skips the
          sheet write and goes straight to the customer reply.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          You must have connected{" "}
          <strong className="text-foreground">Google Sheets</strong> under{" "}
          <a className="underline" href="/settings/integrations">
            Settings → Integrations
          </a>{" "}
          first. The platform writes rows using that connection.
        </p>
      </div>

      {savedBanner ? (
        <Alert variant="success">
          <AlertDescription>Supplier escalation sheet saved.</AlertDescription>
        </Alert>
      ) : null}
      {clearedBanner ? (
        <Alert>
          <AlertDescription>
            Supplier escalation cleared. The agent will skip the sheet
            write on future missing-package cases.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "missing_spreadsheet_id" ? (
        <Alert variant="warning">
          <AlertDescription>
            Spreadsheet ID is required.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "bad_range" ? (
        <Alert variant="warning">
          <AlertDescription>
            Range must be an A1 reference with a sheet name (e.g.{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              Escalations!A:F
            </code>
            ).
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4" aria-hidden />
            Sheet target
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <form action={saveSupplierEscalationAction} className="space-y-4">
            <div className="grid gap-2 sm:max-w-2xl">
              <Label htmlFor="spreadsheetId">Spreadsheet ID</Label>
              <Input
                id="spreadsheetId"
                name="spreadsheetId"
                type="text"
                inputMode="text"
                autoComplete="off"
                defaultValue={sheet?.spreadsheetId ?? ""}
                placeholder="1AbC...xYz"
                required
                aria-describedby="spreadsheet-hint"
              />
              <p
                id="spreadsheet-hint"
                className="text-xs text-muted-foreground"
              >
                Find it in the Sheet URL: <code>docs.google.com/spreadsheets/d/<strong>{"<this part>"}</strong>/edit</code>.
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
                defaultValue={sheet?.range ?? "Escalations!A:F"}
                required
                aria-describedby="range-hint"
              />
              <p id="range-hint" className="text-xs text-muted-foreground">
                A1 reference with sheet name. The agent appends below
                the last non-empty row inside this column span.
              </p>
            </div>

            <div className="grid gap-2 sm:max-w-2xl">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                name="description"
                rows={2}
                defaultValue={sheet?.description ?? ""}
                placeholder="Warehouse ops watches this sheet for delivery exceptions."
              />
              <p className="text-xs text-muted-foreground">
                For your team. Not surfaced to the agent or written to
                the sheet.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save</Button>
              {sheet ? (
                <Button
                  formAction={clearSupplierEscalationAction}
                  type="submit"
                  variant="outline"
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">
          What goes in each row
        </p>
        <p className="mb-2">
          When the missing-package agent escalates, it appends one row
          with these six columns (left-to-right):
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Case ID</li>
          <li>Customer email</li>
          <li>Order name (e.g. #1001)</li>
          <li>Carrier tracking number</li>
          <li>Delivered-at timestamp (ISO 8601)</li>
          <li>Today&apos;s timestamp (ISO 8601)</li>
        </ol>
      </div>
    </div>
  );
}
