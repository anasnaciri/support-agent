import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
  TenantNotFound,
  TenantRepository,
  TenantRepositoryTest,
  TenantSettings,
  defaultRefundPolicy,
  type LegalAcceptance,
  type RefundPolicy,
} from "../src/index.js";

const tenantId = TenantId("00000000-0000-0000-0000-000000000001");

const currentLegalAcceptance: LegalAcceptance = {
  dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
  dpaVersion: DPA_VERSION,
  acceptedAt: "2026-06-04T12:00:00.000Z",
  acceptedByUserId: "11111111-1111-1111-1111-111111111111",
};

const settings = (
  overrides: Partial<ConstructorParameters<typeof TenantSettings>[0]> = {},
): TenantSettings =>
  new TenantSettings({
    notificationEmail: "ops@example.com",
    refundPolicy: defaultRefundPolicy,
    retentionDays: 730,
    supplierEscalationSheet: null,
    legalAcceptance: null,
    ...overrides,
  });

describe("TenantRepositoryTest", () => {
  it("returns the configured settings on getSettings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
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
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
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
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
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
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
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

  it("setSupplierEscalationSheet stores the sheet target (preserves siblings)", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setSupplierEscalationSheet(tenantId, {
            spreadsheetId: "abc123",
            range: "Escalations!A:F",
            description: "warehouse ops",
          });
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
    expect(got.supplierEscalationSheet).toEqual({
      spreadsheetId: "abc123",
      range: "Escalations!A:F",
      description: "warehouse ops",
    });
  });

  it("setSupplierEscalationSheet clears the sheet when passed null", async () => {
    const initial = settings({
      supplierEscalationSheet: {
        spreadsheetId: "abc123",
        range: "Escalations!A:F",
        description: null,
      },
    });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setSupplierEscalationSheet(tenantId, null);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.supplierEscalationSheet).toBeNull();
  });

  it("setSupplierEscalationSheet fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setSupplierEscalationSheet(tenantId, null);
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

  it("setLegalAcceptance records the current notice/DPA acceptance (preserves siblings)", async () => {
    const initial = settings();
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setLegalAcceptance(tenantId, currentLegalAcceptance);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setLegalAcceptance fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setLegalAcceptance(tenantId, currentLegalAcceptance);
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

  it("setRephraseModel stores the model (preserves siblings)", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, "anthropic/claude-haiku-4-5");
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
    expect(got.rephraseModel).toBe("anthropic/claude-haiku-4-5");
  });

  it("setRephraseModel clears the model when passed null", async () => {
    const initial = settings({ rephraseModel: "openai/gpt-4o-mini" });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, null);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.rephraseModel).toBeNull();
  });

  it("setRephraseModel fails when the tenant is absent (TenantNotFound)", async () => {
    const layer = TenantRepositoryTest({});
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setRephraseModel(tenantId, "x");
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
