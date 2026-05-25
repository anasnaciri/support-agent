// ============================================================
// Google Sheets API — low-level wire format
// ============================================================
//
// Plain async functions over `fetch` (no Effect Tag — the Live
// SheetsService wraps these). Mirrors the shape of `gmail-http.ts` so
// the two providers are reviewable side-by-side.
//
// We avoid the `googleapis` npm package (large, Node-coupled auth lib,
// transitive deps); the Sheets surface we need is one `values.append`
// call. Hand-rolled HTTP stays cheap and unit-testable.

// ============================================================
// Errors
// ============================================================

export type SheetsHttpFailure =
  | { readonly kind: "auth_failed"; readonly status: number }
  | { readonly kind: "not_found"; readonly status: number }
  | {
      readonly kind: "invalid";
      readonly status: number;
      readonly message: string;
    }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "network"; readonly status: number; readonly body: string };

export class SheetsHttpError extends Error {
  readonly failure: SheetsHttpFailure;
  constructor(failure: SheetsHttpFailure, message: string) {
    super(message);
    this.failure = failure;
    this.name = "SheetsHttpError";
  }
}

// ============================================================
// Internal fetch wrapper
// ============================================================

interface SheetsFetchOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly token: string;
  readonly body?: unknown;
  readonly fetchImpl?: typeof fetch;
}

const SHEETS_BASE = "https://sheets.googleapis.com/v4";

interface GoogleApiErrorJson {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
  };
}

const extractErrorMessage = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as GoogleApiErrorJson;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON; fall through
  }
  return text.slice(0, 200);
};

const sheetsFetch = async (opts: SheetsFetchOptions): Promise<unknown> => {
  const f = opts.fetchImpl ?? fetch;
  const init: Parameters<typeof fetch>[1] = {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      ...(opts.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const qs = opts.query
    ? `?${new URLSearchParams(opts.query).toString()}`
    : "";
  const res = await f(`${SHEETS_BASE}${opts.path}${qs}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new SheetsHttpError(
        { kind: "auth_failed", status: res.status },
        `sheets ${opts.path}: ${res.status}`,
      );
    }
    if (res.status === 404) {
      throw new SheetsHttpError(
        { kind: "not_found", status: 404 },
        `sheets ${opts.path}: 404`,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      throw new SheetsHttpError(
        { kind: "rate_limited", retryAfterMs: retryAfter * 1000 },
        `sheets ${opts.path}: 429`,
      );
    }
    if (res.status === 400) {
      throw new SheetsHttpError(
        { kind: "invalid", status: 400, message: extractErrorMessage(text) },
        `sheets ${opts.path}: 400 ${text.slice(0, 200)}`,
      );
    }
    throw new SheetsHttpError(
      { kind: "network", status: res.status, body: text },
      `sheets ${opts.path}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as unknown;
};

// ============================================================
// values.append
// ============================================================

export interface SheetsAppendInput {
  readonly token: string;
  readonly spreadsheetId: string;
  readonly range: string;
  readonly values: ReadonlyArray<string | number | boolean | null>;
  readonly fetchImpl?: typeof fetch;
}

export interface SheetsAppendResponse {
  readonly updatedRange: string;
  readonly updatedRows: number;
}

interface RawAppendResponse {
  readonly spreadsheetId?: string;
  readonly tableRange?: string;
  readonly updates?: {
    readonly updatedRange?: string;
    readonly updatedRows?: number;
    readonly updatedColumns?: number;
    readonly updatedCells?: number;
  };
}

/**
 * Append a single row to a Google Sheets range. `valueInputOption=USER_ENTERED`
 * so the API parses formulas / dates / numbers the way an operator typing
 * into the sheet would expect; `insertDataOption=INSERT_ROWS` so an
 * append to a range with data below it doesn't overwrite.
 *
 * On success the API returns an `updates` block whose `updatedRange` is
 * the exact A1 reference Google wrote into (e.g. `Sheet1!A42:F42`). We
 * pass that through so the tool's output is verifiable end-to-end.
 */
export const sheetsAppendRow = async (
  input: SheetsAppendInput,
): Promise<SheetsAppendResponse> => {
  const encodedRange = encodeURIComponent(input.range);
  const raw = (await sheetsFetch({
    method: "POST",
    path: `/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodedRange}:append`,
    query: {
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
    },
    token: input.token,
    body: {
      values: [input.values],
    },
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })) as RawAppendResponse;

  return {
    updatedRange: raw.updates?.updatedRange ?? input.range,
    updatedRows: raw.updates?.updatedRows ?? 1,
  };
};
