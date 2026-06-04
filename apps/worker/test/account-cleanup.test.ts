import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeOrgDirectoryServiceTest,
  makePlatformMailServiceTest,
} from "@support-agent/services";
import { runAccountCleanup } from "../src/account-cleanup.js";

const baseData = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  tenantName: "Acme Co",
  workosOrganizationId: "org_acme" as string | null,
  notificationEmail: "owner@acme.com" as string | null,
};

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
});
