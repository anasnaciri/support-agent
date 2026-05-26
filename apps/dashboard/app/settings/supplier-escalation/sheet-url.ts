const RAW_SPREADSHEET_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

const ensureUrlScheme = (value: string): string => {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^docs\.google\.com\//i.test(value)) return `https://${value}`;
  return value;
};

export const extractGoogleSheetsSpreadsheetId = (
  input: string,
): string | null => {
  const value = input.trim();
  if (value.length === 0) return null;

  // Keep accepting a raw id so existing copied settings or admin-entered
  // values do not break, even though the UI asks merchants for the URL.
  if (RAW_SPREADSHEET_ID_RE.test(value)) return value;

  let url: URL;
  try {
    url = new URL(ensureUrlScheme(value));
  } catch {
    return null;
  }

  if (url.hostname.toLowerCase() !== "docs.google.com") {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const spreadsheetsIndex = parts.indexOf("spreadsheets");
  if (spreadsheetsIndex === -1) return null;

  const idMarkerIndex = parts.indexOf("d", spreadsheetsIndex);
  const id = idMarkerIndex === -1 ? null : parts[idMarkerIndex + 1];
  if (!id || !RAW_SPREADSHEET_ID_RE.test(id)) {
    return null;
  }
  return id;
};

export const googleSheetsUrlForSpreadsheetId = (
  spreadsheetId: string,
): string => `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
