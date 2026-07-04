import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  TicketId,
  SheetsAuthMissing,
  SheetsNotFound,
  TenantId,
  ToolOutputInvalid,
  type SheetsError,
  type ToolContext,
} from "@support-agent/agent-core";
import { SheetsServiceTest } from "@support-agent/services";
import {
  supplierAddSheetRow,
  supplierReadSheetColumns,
} from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (ticketId: string): ToolContext => ({
  tenantId,
  ticketId: TicketId(ticketId),
  agentId: AgentId("missing-package-agent"),
  callId: "call_1",
  attemptNumber: 1,
});

describe("supplier.add_sheet_row tool", () => {
  it("returns a flattened updatedRange/updatedRows payload on success", async () => {
    const env = SheetsServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierAddSheetRow.execute(
          {
            spreadsheetId: "sheet-1",
            range: "Escalations!A:E",
            values: ["ticket-42", "missing package", "urgent", "warehouse", null],
          } as never,
          baseCtx("c-supplier-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as Record<string, unknown>;
    expect(typeof result["updatedRange"]).toBe("string");
    expect(result["updatedRows"]).toBe(1);
  });

  it("maps SheetsNotFound to ToolOutputInvalid with the tag in issues", async () => {
    const env = SheetsServiceTest({
      appendRow: (_t, input) =>
        Effect.fail(
          new SheetsNotFound({
            spreadsheetId: input.spreadsheetId,
            range: input.range,
          }),
        ) as Effect.Effect<never, SheetsError>,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierAddSheetRow.execute(
          {
            spreadsheetId: "ghost",
            range: "Sheet1!A:E",
            values: ["x"],
          } as never,
          baseCtx("c-supplier-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("supplier.add_sheet_row");
        expect(err.issues).toEqual(["SheetsNotFound"]);
      }
    }
  });

  it("maps SheetsAuthMissing to ToolOutputInvalid (tenant hasn't connected Sheets)", async () => {
    const env = SheetsServiceTest({
      appendRow: () =>
        Effect.fail(
          new SheetsAuthMissing({ tenantId }),
        ) as Effect.Effect<never, SheetsError>,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierAddSheetRow.execute(
          {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:E",
            values: ["x"],
          } as never,
          baseCtx("c-supplier-3"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.issues).toEqual(["SheetsAuthMissing"]);
      }
    }
  });

  it("declares risk/permission surface for a customer-visible side effect", () => {
    expect(supplierAddSheetRow.name).toBe("supplier.add_sheet_row");
    expect(supplierAddSheetRow.defaultPermission).toBe("ask");
    expect(supplierAddSheetRow.sideEffectClass).toBe("external_message");
    expect(supplierAddSheetRow.requiredConnectorScopes).toEqual({
      provider: "google_sheets",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  });

  it("read_sheet_columns returns the sheet's header cells", async () => {
    const env = SheetsServiceTest({
      headers: { "sheet-1": ["Ticket ID", "Email", "Order"] },
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierReadSheetColumns.execute(
          {
            spreadsheetId: "sheet-1",
            range: "Escalations!A:F",
          } as never,
          baseCtx("c-read-1"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value as { columns: ReadonlyArray<string> };
    expect(result.columns).toEqual(["Ticket ID", "Email", "Order"]);
  });

  it("read_sheet_columns maps SheetsAuthMissing to ToolOutputInvalid", async () => {
    const env = SheetsServiceTest({
      readHeader: () =>
        Effect.fail(
          new SheetsAuthMissing({ tenantId }),
        ) as Effect.Effect<never, SheetsError>,
    });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        supplierReadSheetColumns.execute(
          {
            spreadsheetId: "sheet-1",
            range: "Escalations!A:F",
          } as never,
          baseCtx("c-read-2"),
        ) as Effect.Effect<unknown, unknown, never>,
        env,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(ToolOutputInvalid);
      if (err instanceof ToolOutputInvalid) {
        expect(err.tool).toBe("supplier.read_sheet_columns");
        expect(err.issues).toEqual(["SheetsAuthMissing"]);
      }
    }
  });

  it("read_sheet_columns is a read-only, auto-allowed tool", () => {
    expect(supplierReadSheetColumns.name).toBe("supplier.read_sheet_columns");
    expect(supplierReadSheetColumns.risk).toBe("read");
    expect(supplierReadSheetColumns.defaultPermission).toBe("allow");
    expect(supplierReadSheetColumns.sideEffectClass).toBe("none");
    expect(supplierReadSheetColumns.requiredConnectorScopes).toEqual({
      provider: "google_sheets",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  });

  it("idempotencyKey ties retries by (spreadsheetId, range)", () => {
    expect(
      supplierAddSheetRow.idempotencyKey!({
        spreadsheetId: "sheet-1",
        range: "Escalations!A:E",
        values: ["a", "b"],
      } as never),
    ).toBe("sheet-row:sheet-1:Escalations!A:E");
    // Different spreadsheet → different key.
    expect(
      supplierAddSheetRow.idempotencyKey!({
        spreadsheetId: "sheet-2",
        range: "Escalations!A:E",
        values: ["a", "b"],
      } as never),
    ).not.toBe(
      supplierAddSheetRow.idempotencyKey!({
        spreadsheetId: "sheet-1",
        range: "Escalations!A:E",
        values: ["a", "b"],
      } as never),
    );
  });
});
