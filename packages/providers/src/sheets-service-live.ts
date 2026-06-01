import { Effect, Layer } from "effect";
import {
  SheetsAppendFailed,
  SheetsAuthFailed,
  SheetsAuthMissing,
  SheetsNotFound,
  SheetsReadFailed,
  type SheetsError,
  type TenantId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  SheetsService,
  type AppendRowInput,
  type AppendRowResult,
  type ReadHeaderInput,
} from "@support-agent/services";
import { refreshGmailToken } from "./gmail-token.js";
import {
  SheetsHttpError,
  sheetsAppendRow,
  sheetsGetValues,
} from "./sheets-http.js";

// ============================================================
// Provider config
// ============================================================

/**
 * Boot-time config for the live Sheets layer. The OAuth client id /
 * secret are the same Google project we use for Gmail — both connectors
 * land in the same Google Cloud OAuth app and refresh through the same
 * `oauth2.googleapis.com/token` endpoint. `refreshSkewMs` lets the
 * layer pre-emptively refresh a borderline-expired token instead of
 * racing the clock and getting a 401.
 */
export interface SheetsProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: typeof fetch;
  /** Defaults to 60 s. */
  readonly refreshSkewMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

// ============================================================
// Error mapping
// ============================================================

const mapHttpError = (
  err: unknown,
  ctx: {
    tenantId: TenantId;
    spreadsheetId: string;
    range: string;
    /** Which operation failed — picks the generic-failure tag. */
    op: "append" | "read";
  },
): SheetsError => {
  // The generic (rate-limit / network / invalid) failure surfaces under
  // an op-specific tag so the audit log distinguishes a header read from
  // a row write even though both share the same {spreadsheetId, message}
  // shape.
  const generic = (message: string): SheetsError =>
    ctx.op === "read"
      ? new SheetsReadFailed({ spreadsheetId: ctx.spreadsheetId, message })
      : new SheetsAppendFailed({ spreadsheetId: ctx.spreadsheetId, message });

  if (err instanceof SheetsHttpError) {
    const f = err.failure;
    if (f.kind === "auth_failed") {
      return new SheetsAuthFailed({ tenantId: ctx.tenantId });
    }
    if (f.kind === "not_found") {
      return new SheetsNotFound({
        spreadsheetId: ctx.spreadsheetId,
        range: ctx.range,
      });
    }
    if (f.kind === "invalid") {
      return generic(f.message);
    }
    // rate_limited + network both surface as a generic failure — the tool
    // boundary sees the message verbatim so the operator can tell the
    // difference in the audit log.
    return generic(err.message);
  }
  return generic(err instanceof Error ? err.message : String(err));
};

// ============================================================
// Live Layer
// ============================================================

/**
 * Live `SheetsService` over Google Sheets. Resolves per-tenant tokens
 * via `ConnectorCredentialStore` (provider `"google_sheets"`),
 * refreshes them on expiry, and maps API failures into the
 * provider-neutral `SheetsError` union.
 *
 * Token refresh shares `refreshGmailToken` from the Gmail provider —
 * both connectors call the same Google OAuth2 token endpoint, the
 * function name is historical. We do not extract it into a shared
 * helper here; the implementation is identical and rename-only.
 */
export const SheetsServiceLive = (
  cfg: SheetsProviderConfig,
): Layer.Layer<SheetsService, never, ConnectorCredentialStore> =>
  Layer.effect(
    SheetsService,
    Effect.gen(function* () {
      const store = yield* ConnectorCredentialStore;
      const skew = cfg.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;

      const resolveToken = (tenantId: TenantId) =>
        Effect.gen(function* () {
          const conn = yield* store
            .get(tenantId, "google_sheets")
            .pipe(
              Effect.mapError(
                (): SheetsError => new SheetsAuthMissing({ tenantId }),
              ),
            );
          if (!conn.refreshToken) {
            return yield* Effect.fail(new SheetsAuthMissing({ tenantId }));
          }
          const expiresAt = conn.tokenExpiresAt;
          const expired =
            expiresAt === null || expiresAt.getTime() - skew < Date.now();
          if (!expired) {
            return conn;
          }
          const refreshed = yield* Effect.tryPromise({
            try: () =>
              refreshGmailToken({
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                refreshToken: conn.refreshToken!,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (): SheetsError => new SheetsAuthFailed({ tenantId }),
          });
          const patched = yield* store
            .patchTokens({
              tenantId,
              provider: "google_sheets",
              shopDomain: conn.shopDomain,
              accessToken: refreshed.accessToken,
              tokenExpiresAt: refreshed.expiresAt,
            })
            .pipe(
              Effect.mapError(
                (): SheetsError => new SheetsAuthFailed({ tenantId }),
              ),
            );
          return patched;
        });

      const appendRow = (
        tenantId: TenantId,
        input: AppendRowInput,
      ): Effect.Effect<AppendRowResult, SheetsError> =>
        Effect.gen(function* () {
          const conn = yield* resolveToken(tenantId);
          const result = yield* Effect.tryPromise({
            try: () =>
              sheetsAppendRow({
                token: conn.accessToken,
                spreadsheetId: input.spreadsheetId,
                range: input.range,
                values: input.values,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) =>
              mapHttpError(cause, {
                tenantId,
                spreadsheetId: input.spreadsheetId,
                range: input.range,
                op: "append",
              }),
          });
          return {
            updatedRange: result.updatedRange,
            updatedRows: result.updatedRows,
          };
        });

      const readHeader = (
        tenantId: TenantId,
        input: ReadHeaderInput,
      ): Effect.Effect<ReadonlyArray<string>, SheetsError> =>
        Effect.gen(function* () {
          const conn = yield* resolveToken(tenantId);
          // Read only the first row of the target sheet. We derive a
          // `<sheet>!1:1` range from the configured append range so a big
          // sheet doesn't pull its whole column span back just to learn
          // the header.
          const sheetName = input.range.includes("!")
            ? input.range.slice(0, input.range.indexOf("!"))
            : input.range;
          const headerRange = `${sheetName}!1:1`;
          const rows = yield* Effect.tryPromise({
            try: () =>
              sheetsGetValues({
                token: conn.accessToken,
                spreadsheetId: input.spreadsheetId,
                range: headerRange,
                ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
              }),
            catch: (cause) =>
              mapHttpError(cause, {
                tenantId,
                spreadsheetId: input.spreadsheetId,
                range: headerRange,
                op: "read",
              }),
          });
          const first = rows[0] ?? [];
          // Coerce each cell to a trimmed string; blanks stay "".
          return first.map((cell) =>
            cell === null || cell === undefined ? "" : String(cell).trim(),
          );
        });

      return SheetsService.of({
        appendRow,
        readHeader,
      });
    }),
  );
