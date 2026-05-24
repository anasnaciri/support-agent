import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  TenantNotFound,
  TenantRepository,
  TenantRepositoryTest,
  TenantSettings,
  defaultRefundPolicy,
  type RefundPolicy,
} from "../src/index.js";

const tenantId = TenantId("00000000-0000-0000-0000-000000000001");

describe("TenantRepositoryTest", () => {
  it("returns the configured settings on getSettings", async () => {
    const settings = new TenantSettings({
      notificationEmail: "ops@example.com",
      refundPolicy: defaultRefundPolicy,
      retentionDays: 730,
    });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, settings]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy.askAboveMinorUnits).toBe(0);
  });

  it("fails with TenantNotFound when the tenant is absent", async () => {
    const layer = TenantRepositoryTest({});
    await expect(
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const repo = yield* TenantRepository;
            return yield* repo.getSettings(tenantId);
          }),
          layer,
        ),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("setRefundPolicy replaces the refundPolicy block (preserves notificationEmail)", async () => {
    const initial = new TenantSettings({
      notificationEmail: "ops@example.com",
      refundPolicy: defaultRefundPolicy,
      retentionDays: 730,
    });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const updatedPolicy: RefundPolicy = {
      askAboveMinorUnits: 2500,
      denyAboveMinorUnits: 20000,
      currencyCode: "EUR",
    };
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRefundPolicy(tenantId, updatedPolicy);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(updatedPolicy);
  });

  it("setRefundPolicy fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRefundPolicy(tenantId, defaultRefundPolicy);
        }),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = (exit.cause as { error?: unknown }).error;
      expect(err).toBeInstanceOf(TenantNotFound);
    }
  });
});
