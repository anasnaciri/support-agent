import { Context, Effect, Layer } from "effect";
import {
  SheetsAppendFailed,
  SheetsNotFound,
  type SheetsError,
  type TenantId,
} from "@support-agent/agent-core";

/**
 * Input for `SheetsService.appendRow`. The Live impl translates this into
 * a single `values.append` call against the Google Sheets API with
 * `valueInputOption=USER_ENTERED` (so date strings, formulas, and number
 * formats render the way an operator pasting into the sheet would
 * expect) and `insertDataOption=INSERT_ROWS` (so we never overwrite an
 * existing row when the target range has data below it).
 *
 * `range` is an A1 reference that includes the sheet name —
 * `Sheet1!A:F` is the canonical shape. Google appends below the last
 * non-empty row within the column span, so the column letters bound
 * which columns the row lands in even when the table isn't anchored at
 * row 1.
 *
 * `values` are scalars only (string | number | boolean | null). The Live
 * impl serializes them as strings; numbers stay numbers because
 * `USER_ENTERED` re-parses them on the API side.
 */
export interface AppendRowInput {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly values: ReadonlyArray<string | number | boolean | null>;
}

export interface AppendRowResult {
  /** The range Google said it wrote to — e.g. `Sheet1!A42:F42`. */
  readonly updatedRange: string;
  readonly updatedRows: number;
}

/**
 * Provider-neutral Sheets surface. Today the only Live impl is Google
 * Sheets, but the Tag is intentionally narrow so a future Microsoft
 * Excel / Smartsheet / Airtable layer could implement the same shape.
 *
 * Tools call into this Tag — never `fetch` against the Sheets API
 * directly — so unit tests can drive the in-memory `SheetsServiceTest`
 * layer and the same tool code runs in prod against the Live HTTP impl.
 */
export class SheetsService extends Context.Tag("SheetsService")<
  SheetsService,
  {
    readonly appendRow: (
      tenantId: TenantId,
      input: AppendRowInput,
    ) => Effect.Effect<AppendRowResult, SheetsError>;
  }
>() {}

// ============================================================
// Test layer — in-memory, deterministic
// ============================================================

export interface SheetsTestFixtures {
  /**
   * Known spreadsheets keyed by id. Unknown ids return `SheetsNotFound`.
   * Each row appended bumps the per-(spreadsheet, range) counter so the
   * synthesized `updatedRange` reflects something the caller can assert
   * against without coupling to a Sheets-API-shaped row number.
   */
  readonly spreadsheets?: ReadonlyArray<string>;
  /** Optional override for the `appendRow` impl — full replacement. */
  readonly appendRow?: (
    tenantId: TenantId,
    input: AppendRowInput,
  ) => Effect.Effect<AppendRowResult, SheetsError>;
}

/**
 * In-memory `SheetsService` for unit tests. Records appends in an
 * internal array (accessible via the closure-bound `recorded` getter
 * on the returned layer? no — tests assert via the override callback
 * instead, mirroring the Shopify Test layer pattern). Default impl
 * synthesises a deterministic `updatedRange` so tool tests can assert
 * the result shape without a real API.
 */
export const SheetsServiceTest = (fixtures: SheetsTestFixtures = {}) =>
  Layer.succeed(
    SheetsService,
    SheetsService.of({
      appendRow: (tenantId, input) => {
        if (fixtures.appendRow) {
          return fixtures.appendRow(tenantId, input);
        }
        if (
          fixtures.spreadsheets &&
          !fixtures.spreadsheets.includes(input.spreadsheetId)
        ) {
          return Effect.fail(
            new SheetsNotFound({
              spreadsheetId: input.spreadsheetId,
              range: input.range,
            }),
          );
        }
        if (input.values.length === 0) {
          return Effect.fail(
            new SheetsAppendFailed({
              spreadsheetId: input.spreadsheetId,
              message: "row is empty",
            }),
          );
        }
        // Synthesize a deterministic updatedRange. We don't track row
        // numbers across appends — the test override does that when it
        // matters.
        const sheetPrefix = input.range.includes("!")
          ? input.range.split("!")[0]
          : "Sheet1";
        const synthRange = `${sheetPrefix}!A1:${String.fromCharCode(
          64 + Math.max(1, input.values.length),
        )}1`;
        return Effect.succeed({
          updatedRange: synthRange,
          updatedRows: 1,
        });
      },
    }),
  );
