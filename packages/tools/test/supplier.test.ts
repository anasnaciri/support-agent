import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CaseId,
  SheetsAuthMissing,
  SheetsNotFound,
  TenantId,
  ToolOutputInvalid,
  type SheetsError,
  type ToolContext,
} from "@support-agent/agent-core";
import { SheetsServiceTest } from "@support-agent/services";
import { supplierAddSheetRow } from "../src/index.js";

const tenantId = TenantId("t1");
const baseCtx = (caseId: string): ToolContext => ({
  tenantId,
  caseId: CaseId(caseId),
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
            values: ["case-42", "missing package", "urgent", "warehouse", null],
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
