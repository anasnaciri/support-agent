import { Effect, Schema } from "effect";
import { defineTool, ToolOutputInvalid } from "@support-agent/agent-core";
import { SheetsService } from "@support-agent/services";

const Input = Schema.Struct({
  spreadsheetId: Schema.String,
  // A1 reference that includes the sheet name — e.g. `Escalations!A:F`.
  // Only the sheet name matters here; the header is always read from the
  // first row of that sheet.
  range: Schema.String,
});

const Output = Schema.Struct({
  // The sheet's header cells, left-to-right, as strings. Blank header
  // cells come back as "". An empty array means the sheet has no header
  // row yet — the caller should fall back to its own default layout.
  columns: Schema.Array(Schema.String),
});

export const supplierReadSheetColumns = defineTool({
  name: "supplier.read_sheet_columns",
  description:
    "Read the header row (column names) of a shared Google Sheets spreadsheet so a later `supplier.add_sheet_row` can be aligned to the sheet's own schema instead of a fixed column order. The tenant must have connected Google Sheets first; failures surface as `SheetsAuthMissing` until they do. `range` is an A1 reference with sheet name (e.g. `Escalations!A:F`) — only the sheet name is used; the header is always the first row. Returns `columns`: the header cells left-to-right as strings (blank cells are `\"\"`, an empty array means no header row exists yet). Read-only: defaultPermission is `allow`.",
  inputSchema: Input,
  outputSchema: Output,
  risk: "read",
  defaultPermission: "allow",
  sideEffectClass: "none",
  requiredConnectorScopes: {
    provider: "google_sheets",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  },
  execute: (input, ctx) =>
    Effect.gen(function* () {
      const sheets = yield* SheetsService;
      const columns = yield* sheets
        .readHeader(ctx.tenantId, {
          spreadsheetId: input.spreadsheetId,
          range: input.range,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new ToolOutputInvalid({
                tool: "supplier.read_sheet_columns",
                issues: [e._tag],
              }),
          ),
        );
      return { columns: columns.map((c) => c) };
    }),
});
