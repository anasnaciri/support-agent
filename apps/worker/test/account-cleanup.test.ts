import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  encrypt,
  makeOrgDirectoryServiceTest,
  makePlatformMailServiceTest,
} from "@support-agent/services";
import {
  runAccountCleanup,
  type EncryptedConnectorGrant,
} from "../src/account-cleanup.js";

const baseData = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  tenantName: "Acme Co",
  workosOrganizationId: "org_acme" as string | null,
  notificationEmail: "owner@acme.com" as string | null,
};

const KEY = randomBytes(32);
const encB64 = (s: string): string => encrypt(KEY, s).toString("base64");

const grant = (
  overrides: Partial<EncryptedConnectorGrant> = {},
): EncryptedConnectorGrant => ({
  provider: "shopify",
  shopDomain: "pilot.myshopify.com",
  accessTokenEncrypted: encB64("shpat_live"),
  refreshTokenEncrypted: null,
  apiVersion: "2025-01",
  ...overrides,
});

const okFetch = () =>
  ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({}),
    headers: new Headers(),
  }) as unknown as Response;

describe("runAccountCleanup", () => {
  it("deletes the WorkOS org AND sends the deletion email", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();

    await Effect.runPromise(
      Effect.provide(
        runAccountCleanup(baseData),
        Layer.mergeAll(org.layer, mail.layer),
      ),
    );

    expect(org.handle.deleted).toEqual(["org_acme"]);
    expect(mail.handle.sent).toHaveLength(1);
    const record = mail.handle.sent[0]!;
    expect(record.kind).toBe("account-deleted");
    if (record.kind === "account-deleted") {
      expect(record.input.recipientEmail).toBe("owner@acme.com");
      expect(record.input.tenantName).toBe("Acme Co");
    }
  });

  it("skips the WorkOS step when the tenant has no org (admin-deleted headless tenant)", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();

    await Effect.runPromise(
      Effect.provide(
        runAccountCleanup({ ...baseData, workosOrganizationId: null }),
        Layer.mergeAll(org.layer, mail.layer),
      ),
    );

    expect(org.handle.deleted).toEqual([]);
    expect(mail.handle.sent).toHaveLength(1);
  });

  it("skips the email step when no notification email was captured", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();

    await Effect.runPromise(
      Effect.provide(
        runAccountCleanup({ ...baseData, notificationEmail: null }),
        Layer.mergeAll(org.layer, mail.layer),
      ),
    );

    expect(org.handle.deleted).toEqual(["org_acme"]);
    expect(mail.handle.sent).toEqual([]);
  });

  it("fails (so pg-boss retries) when the WorkOS delete fails", async () => {
    const org = makeOrgDirectoryServiceTest({
      failFor: new Set(["org_acme"]),
    });
    const mail = makePlatformMailServiceTest();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          runAccountCleanup(baseData),
          Layer.mergeAll(org.layer, mail.layer),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    // Org delete failed before the email — email not attempted.
    expect(mail.handle.sent).toEqual([]);
  });

  // ---- B1: provider-side OAuth grant revocation ----

  it("revokes each connector grant provider-side before org delete + email", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();
    const calls: Array<string> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return okFetch();
    });

    await Effect.runPromise(
      Effect.provide(
        runAccountCleanup(
          {
            ...baseData,
            connectorGrants: [
              grant({ provider: "shopify" }),
              grant({
                provider: "gmail",
                shopDomain: "ops@store.com",
                accessTokenEncrypted: encB64("ya29_a"),
                refreshTokenEncrypted: encB64("1//refresh"),
                apiVersion: null,
              }),
            ],
          },
          { encryptionKey: KEY, fetchImpl },
        ),
        Layer.mergeAll(org.layer, mail.layer),
      ),
    );

    // Shopify uninstall + Gmail watch-stop + Google token revoke all hit.
    expect(calls.some((u) => u.includes("api_permissions/current.json"))).toBe(
      true,
    );
    expect(calls.some((u) => u.includes("/users/me/stop"))).toBe(true);
    expect(calls.some((u) => u === "https://oauth2.googleapis.com/revoke")).toBe(
      true,
    );
    // Cleanup still completed.
    expect(org.handle.deleted).toEqual(["org_acme"]);
    expect(mail.handle.sent).toHaveLength(1);
  });

  it("FAILS the job (so pg-boss retries) when a provider revoke errors, and does not run org/email", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();
    const fetchImpl = vi.fn(async () => {
      throw new Error("provider down");
    });

    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          runAccountCleanup(
            { ...baseData, connectorGrants: [grant()] },
            { encryptionKey: KEY, fetchImpl },
          ),
          Layer.mergeAll(org.layer, mail.layer),
        ),
      ),
    );

    // Revocation failed → the whole job fails so pg-boss retries it. Because
    // revocation runs FIRST, the org delete + the (non-idempotent) email were
    // NOT performed — so a retry won't double-send the email.
    expect(result._tag).toBe("Left");
    expect(org.handle.deleted).toEqual([]);
    expect(mail.handle.sent).toEqual([]);
  });

  it("FAILS the job when a provider returns a non-2xx revoke status", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();
    // 500 from Shopify uninstall → `failed` outcome → job fails.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => "",
          json: async () => ({}),
          headers: new Headers(),
        }) as unknown as Response,
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          runAccountCleanup(
            { ...baseData, connectorGrants: [grant({ provider: "shopify" })] },
            { encryptionKey: KEY, fetchImpl },
          ),
          Layer.mergeAll(org.layer, mail.layer),
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(org.handle.deleted).toEqual([]);
  });

  it("does NOT fail when the grant is already gone provider-side (401/already_gone)", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();
    // 401 → token already invalid → already_gone → success.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          text: async () => "",
          json: async () => ({}),
          headers: new Headers(),
        }) as unknown as Response,
    );

    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          runAccountCleanup(
            { ...baseData, connectorGrants: [grant({ provider: "shopify" })] },
            { encryptionKey: KEY, fetchImpl },
          ),
          Layer.mergeAll(org.layer, mail.layer),
        ),
      ),
    );

    expect(result._tag).toBe("Right");
    expect(org.handle.deleted).toEqual(["org_acme"]);
    expect(mail.handle.sent).toHaveLength(1);
  });

  it("skips revocation (still does org + email) when no encryption key is configured", async () => {
    const org = makeOrgDirectoryServiceTest();
    const mail = makePlatformMailServiceTest();
    const fetchImpl = vi.fn(async () => okFetch());

    await Effect.runPromise(
      Effect.provide(
        runAccountCleanup(
          { ...baseData, connectorGrants: [grant()] },
          { encryptionKey: null, fetchImpl },
        ),
        Layer.mergeAll(org.layer, mail.layer),
      ),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(org.handle.deleted).toEqual(["org_acme"]);
    expect(mail.handle.sent).toHaveLength(1);
  });
});
