import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  SheetsAppendFailed,
  SheetsAuthFailed,
  SheetsAuthMissing,
  SheetsNotFound,
  SheetsReadFailed,
  TenantId,
} from "@support-agent/agent-core";
import {
  ConnectorCredentialStore,
  SheetsService,
} from "@support-agent/services";
import { SheetsServiceLive } from "../src/sheets-service-live.js";

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: new Headers(),
  }) as unknown as Response;

const seededStore = (overrides?: {
  readonly tokenExpiresAt?: Date | null;
  readonly refreshToken?: string | null;
}) =>
  Layer.sync(ConnectorCredentialStore, () => {
    const row = {
      tenantId,
      provider: "google_sheets" as const,
      shopDomain: "ops@merchant.com",
      accessToken: "live-token",
      refreshToken:
        overrides?.refreshToken !== undefined
          ? overrides.refreshToken
          : "refresh-token",
      tokenExpiresAt:
        overrides?.tokenExpiresAt !== undefined
          ? overrides.tokenExpiresAt
          : new Date(Date.now() + 60 * 60_000),
      metadata: {} as Readonly<Record<string, unknown>>,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"] as ReadonlyArray<string>,
      apiVersion: null,
      installedAt: new Date(),
      status: "active" as const,
    };
    return ConnectorCredentialStore.of({
      get: () => Effect.succeed(row),
      put: () => Effect.succeed(row),
      revoke: () => Effect.void,
      listForTenant: () => Effect.succeed([row]),
      patchTokens: (input) =>
        Effect.succeed({
          ...row,
          accessToken: input.accessToken,
          tokenExpiresAt: input.tokenExpiresAt,
        }),
      patchMetadata: () => Effect.die("unused"),
    });
  });

const missingStore = () =>
  Layer.sync(ConnectorCredentialStore, () =>
    ConnectorCredentialStore.of({
      get: () =>
        Effect.fail(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { _tag: "ConnectorNotFound" } as any,
        ),
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      listForTenant: () => Effect.succeed([]),
      patchTokens: () => Effect.die("unused"),
      patchMetadata: () => Effect.die("unused"),
    }),
  );

describe("SheetsServiceLive", () => {
  it("appendRow happy path posts to values.append and returns updatedRange", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain(
        "/spreadsheets/sheet-1/values/Escalations!A%3AE:append",
      );
      expect(url).toContain("valueInputOption=USER_ENTERED");
      expect(url).toContain("insertDataOption=INSERT_ROWS");
      return okJson({
        spreadsheetId: "sheet-1",
        updates: {
          updatedRange: "Escalations!A42:E42",
          updatedRows: 1,
        },
      });
    });

    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

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
    expect(result.updatedRange).toBe("Escalations!A42:E42");
    expect(result.updatedRows).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("appendRow refreshes an expired token before the API call", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return okJson({ access_token: "fresh-token", expires_in: 3600 });
      }
      return okJson({
        updates: { updatedRange: "Sheet1!A1:C1", updatedRows: 1 },
      });
    });
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(
      Layer.provide(seededStore({ tokenExpiresAt: new Date(Date.now() - 1000) })),
    );

    await Effect.runPromise(
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

    // First call should be token refresh, second should be the API.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstCall = fetchImpl.mock.calls[0]![0];
    const firstUrl =
      typeof firstCall === "string" ? firstCall : firstCall.toString();
    expect(firstUrl).toBe("https://oauth2.googleapis.com/token");
  });

  it("appendRow maps 404 to SheetsNotFound", async () => {
    const fetchImpl = vi.fn(async () => fail(404, "not found"));
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

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
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsNotFound);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("appendRow maps 400 to SheetsAppendFailed with API message", async () => {
    const fetchImpl = vi.fn(async () =>
      fail(
        400,
        JSON.stringify({
          error: { code: 400, message: "Unable to parse range: Bad!A:Z" },
        }),
      ),
    );
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Bad!A:Z",
            values: ["a"],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err).toBeInstanceOf(SheetsAppendFailed);
      expect((err as SheetsAppendFailed).message).toContain(
        "Unable to parse range",
      );
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("appendRow maps 401 to SheetsAuthFailed", async () => {
    const fetchImpl = vi.fn(async () => fail(401, "unauthorized"));
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:C",
            values: ["a"],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsAuthFailed);
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("appendRow fails with SheetsAuthMissing when no connector row exists", async () => {
    const fetchImpl = vi.fn(async () => okJson({}));
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(missingStore()));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:C",
            values: ["a"],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsAuthMissing);
    } else {
      throw new Error("expected Fail cause");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("readHeader GETs the first row of the sheet and returns trimmed strings", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // Derives a `<sheet>!1:1` range from the configured append range so
      // it never pulls the whole column span back.
      expect(url).toContain("/spreadsheets/sheet-1/values/Escalations!1%3A1");
      expect(url).toContain("majorDimension=ROWS");
      return okJson({
        range: "Escalations!1:1",
        majorDimension: "ROWS",
        values: [["Case ID", " Email ", "Order", 5]],
      });
    });
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

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
    expect(result).toEqual(["Case ID", "Email", "Order", "5"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("readHeader returns [] when the sheet has no values", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({ range: "Sheet1!1:1", majorDimension: "ROWS" }),
    );
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.readHeader(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:C",
          }),
        ),
        layer,
      ),
    );
    expect(result).toEqual([]);
  });

  it("readHeader maps 400 to SheetsReadFailed with the API message", async () => {
    const fetchImpl = vi.fn(async () =>
      fail(
        400,
        JSON.stringify({
          error: { code: 400, message: "Unable to parse range: Bad!1:1" },
        }),
      ),
    );
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore()));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.readHeader(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Bad!A:Z",
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err).toBeInstanceOf(SheetsReadFailed);
      expect((err as SheetsReadFailed).message).toContain("Unable to parse range");
    } else {
      throw new Error("expected Fail cause");
    }
  });

  it("appendRow fails with SheetsAuthMissing when the connector has no refresh token", async () => {
    const fetchImpl = vi.fn(async () => okJson({}));
    const layer = SheetsServiceLive({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).pipe(Layer.provide(seededStore({ refreshToken: null })));

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(SheetsService, (s) =>
          s.appendRow(tenantId, {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A:C",
            values: ["a"],
          }),
        ),
        layer,
      ),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(SheetsAuthMissing);
    } else {
      throw new Error("expected Fail cause");
    }
  });
});
