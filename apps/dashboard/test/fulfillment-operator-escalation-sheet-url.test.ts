import { describe, expect, it } from "vitest";

import {
  extractGoogleSheetsSpreadsheetId,
  googleSheetsUrlForSpreadsheetId,
} from "../app/settings/fulfillment-operator-escalation/sheet-url.js";

const SHEET_ID = "1AbCdefGhijKlmnOPQrst_Uvwxyz-1234567890";

describe("fulfillment partner escalation sheet URL helpers", () => {
  it("extracts the spreadsheet id from the normal Google Sheets URL", () => {
    expect(
      extractGoogleSheetsSpreadsheetId(
        `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=0#gid=0`,
      ),
    ).toBe(SHEET_ID);
  });

  it("extracts the id from account-indexed Sheets URLs", () => {
    expect(
      extractGoogleSheetsSpreadsheetId(
        `https://docs.google.com/spreadsheets/u/0/d/${SHEET_ID}/edit`,
      ),
    ).toBe(SHEET_ID);
  });

  it("accepts a docs.google.com URL without a scheme", () => {
    expect(
      extractGoogleSheetsSpreadsheetId(
        `docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      ),
    ).toBe(SHEET_ID);
  });

  it("keeps accepting raw ids for backwards compatibility", () => {
    expect(extractGoogleSheetsSpreadsheetId(SHEET_ID)).toBe(SHEET_ID);
  });

  it("rejects non-Sheets URLs and published d/e links", () => {
    expect(
      extractGoogleSheetsSpreadsheetId(
        `https://example.com/spreadsheets/d/${SHEET_ID}/edit`,
      ),
    ).toBeNull();
    expect(
      extractGoogleSheetsSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ/pubhtml",
      ),
    ).toBeNull();
  });

  it("formats a stored id back into a merchant-friendly URL", () => {
    expect(googleSheetsUrlForSpreadsheetId(SHEET_ID)).toBe(
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
    );
  });
});
