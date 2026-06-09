import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { SheetsService } from "@support-agent/services";

// Sheet cells can hold strings, numbers, booleans, or be blank. We
// accept that exact set — `null` becomes an empty cell server-side
// under `valueInputOption=USER_ENTERED`.
const CellValue = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
);

const Input = Schema.Struct({
  spreadsheetId: Schema.String,
  // A1 reference that includes the sheet name — e.g. `Escalations!A:E`.
  // Google appends below the last non-empty row inside this column span.
  range: Schema.String,
  // One row's worth of cells, left-to-right. Length is not validated
  // against the range — the API quietly truncates / pads, which is the
  // behaviour we want for evolving sheets.
  values: Schema.Array(CellValue),
});

const Output = Schema.Struct({
  updatedRange: Schema.String,
  updatedRows: Schema.Number,
});

export const supplierAddSheetRow = defineTool({
  name: "supplier.add_sheet_row",
  description:
    "Append a row to a shared Google Sheets spreadsheet. Used to escalate a support case to warehouse / ops via a shared sheet they already watch. The tenant must have connected Google Sheets in Settings → Integrations first; failures surface as `SheetsAuthMissing` until they do. `range` is an A1 reference with sheet name (e.g. `Escalations!A:E`); Google appends below the last non-empty row within those columns, so existing data is never overwritten. `values` is one row's cells left-to-right — strings, numbers, booleans, or null for blank. Permission policy: defaultPermission is `ask` — writing to a shared sheet is operator-visible and irreversible without manual cleanup, so it requires human approval until per-tenant policy raises trust.",
  displayName: "Escalate to supplier",
  displayDescription:
    "The agent logs an escalation row to your supplier sheet (e.g. for missing-package or warehouse claims).",
  tenantControl: "permission-toggle",
  inputSchema: Input,
  outputSchema: Output,
  risk: "communicate",
  // Writing to a shared sheet is visible to anyone with sheet access
  // (often the whole ops team). Treating it as an external message is
  // the closest fit on the existing taxonomy — it isn't financial, but
  // it isn't internal-only either.
  defaultPermission: "ask",
  sideEffectClass: "external_message",
  requiredConnectorScopes: {
    provider: "google_sheets",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  },
  // Bind retries together: (spreadsheetId, range, callId) keeps a
  // runtime retry from double-writing. The Sheets API itself has no
  // append-level idempotency, so this is best-effort at the runtime
  // layer — once a request leaves us we trust the (caseId, callId)
  // dedup that AgentRuntime already enforces.
  idempotencyKey: (input) =>
    `sheet-row:${input.spreadsheetId}:${input.range}`,
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const sheets = yield* SheetsService;
      const result = yield* sheets
        .appendRow(ctx.tenantId, {
          spreadsheetId: input.spreadsheetId,
          range: input.range,
          values: input.values.map((v) => v),
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "supplier.add_sheet_row",
                issues: [e._tag],
              }),
          ),
        );
      return {
        updatedRange: result.updatedRange,
        updatedRows: result.updatedRows,
      };
    }),
});
