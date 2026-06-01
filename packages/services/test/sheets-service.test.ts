import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  SheetsAppendFailed,
  SheetsNotFound,
  TenantId,
} from "@support-agent/agent-core";
import {
  SheetsService,
  SheetsServiceTest,
  type AppendRowInput,
} from "../src/sheets-service.js";

const tenantId = TenantId("t1");

describe("SheetsServiceTest", () => {
  it("appendRow synthesises an updatedRange on the default impl", async () => {
    const layer = SheetsServiceTest({});
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Escalations!A:E",
            values: ["case-42", "missing package", "urgent", "warehouse", null],
          }),
        ),
        layer,
      ),
    );
    expect(result.updatedRows).toBe(1);
    expect(result.updatedRange.startsWith("Escalations!")).toBe(true);
  });

  it("appendRow fails with SheetsNotFound when the id isn't in the allowlist", async () => {
    const layer = SheetsServiceTest({ spreadsheets: ["known"] });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "ghost",
            range: "Sheet1!A:C",
            values: ["x"],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    const cause = exit.cause;
    expect(cause._tag).toBe("Fail");
    if (cause._tag === "Fail") {
      expect(cause.error).toBeInstanceOf(SheetsNotFound);
    }
  });

  it("appendRow fails with SheetsAppendFailed when values is empty", async () => {
    const layer = SheetsServiceTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "any",
            range: "Sheet1!A:C",
            values: [],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsAppendFailed);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("readHeader returns the fixture header row for a known spreadsheet", async () => {
    const layer = SheetsServiceTest({
      headers: { "sheet-1": ["Case", "Email", "Order"] },
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.readHeader(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Escalations!A:F",
          }),
        ),
        layer,
      ),
    );
    expect(result).toEqual(["Case", "Email", "Order"]);
  });

  it("readHeader returns [] when the spreadsheet has no fixture header", async () => {
    const layer = SheetsServiceTest({});
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.readHeader(tenantId, {
            spreadsheetId: "blank",
            range: "Sheet1!A:C",
          }),
        ),
        layer,
      ),
    );
    expect(result).toEqual([]);
  });

  it("readHeader fails with SheetsNotFound when the id isn't in the allowlist", async () => {
    const layer = SheetsServiceTest({ spreadsheets: ["known"] });
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.readHeader(tenantId, {
            spreadsheetId: "ghost",
            range: "Sheet1!A:C",
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsNotFound);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("appendRow runs the override impl when provided", async () => {
    const received: AppendRowInput[] = [];
    const layer = SheetsServiceTest({
      appendRow: (_tid, input) => {
        received.push(input);
        return Effect.succeed({
          updatedRange: "Custom!A99:C99",
          updatedRows: 1,
        });
      },
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:C",
            values: ["a", "b", "c"],
          }),
        ),
        layer,
      ),
    );
    expect(result.updatedRange).toBe("Custom!A99:C99");
    expect(received).toHaveLength(1);
    expect(received[0]!.spreadsheetId).toBe("sheet-1");
  });
});
