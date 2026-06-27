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
  decodeResolutionPolicy,
  defaultRefundPolicy,
  defaultDiscountPolicy,
  defaultResolutionPolicy,
  type LegalAcceptance,
  type RefundPolicy,
  type ResolutionPolicy,
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
    discountPolicy: defaultDiscountPolicy,
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

  it("setResolutionPolicy round-trips and preserves siblings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const custom: ResolutionPolicy = {
      scenarios: [
        {
          key: "vip_complaint",
          label: "VIP complaint",
          builtin: false,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          supplierMode: "none",
        },
      ],
    };
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setResolutionPolicy(tenantId, custom);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.resolutionPolicy).toEqual(custom);
    expect(got.notificationEmail).toBe("ops@example.com");
    expect(got.legalAcceptance).toEqual(currentLegalAcceptance);
  });

  it("setResolutionAgentEnabled round-trips and preserves siblings", async () => {
    const initial = settings({ legalAcceptance: currentLegalAcceptance });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setResolutionAgentEnabled(tenantId, true);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.resolutionAgentEnabled).toBe(true);
    expect(got.notificationEmail).toBe("ops@example.com");
  });
});

describe("decodeResolutionPolicy (defaults-on-read)", () => {
  it("returns the seeded built-ins when the value is absent", () => {
    const p = decodeResolutionPolicy(undefined);
    expect(p.scenarios.length).toBeGreaterThanOrEqual(5);
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
    expect(p.scenarios.map((s) => s.key)).toContain("refund_request");
  });

  it("falls back to defaults on malformed input", () => {
    expect(decodeResolutionPolicy(42)).toEqual(defaultResolutionPolicy);
    expect(decodeResolutionPolicy({ scenarios: "nope" })).toEqual(
      defaultResolutionPolicy,
    );
  });

  it("keeps a valid custom scenario", () => {
    const raw = {
      scenarios: [
        {
          key: "vip_complaint",
          label: "VIP complaint",
          recognition: "An angry high-value customer",
          builtin: false,
          enabledActions: [{ tool: "refund.create", permission: "ask" }],
          supplierMode: "none",
          notes: "Be extra gracious.",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0]!.key).toBe("vip_complaint");
    expect(p.scenarios[0]!.enabledActions[0]).toEqual({
      tool: "refund.create",
      permission: "ask",
    });
    expect(p.scenarios[0]!.supplierMode).toBe("none");
    expect(p.scenarios[0]!.notes).toBe("Be extra gracious.");
  });

  it("falls back to defaults when no scenario is valid (bad supplierMode / empty key)", () => {
    const raw = {
      scenarios: [
        {
          key: "bad",
          label: "Bad",
          builtin: false,
          enabledActions: [],
          supplierMode: "whenever", // invalid supplierMode → scenario dropped
        },
        {
          key: "", // empty key → scenario dropped
          label: "Empty key",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    };
    expect(decodeResolutionPolicy(raw)).toEqual(defaultResolutionPolicy);
  });

  it("drops invalid actions but keeps the otherwise-valid scenario", () => {
    const raw = {
      scenarios: [
        {
          key: "mix",
          label: "Mix",
          builtin: false,
          enabledActions: [
            { tool: "refund.create", permission: "ask" },
            { tool: 5, permission: "allow" },
          ],
          supplierMode: "none",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0]!.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });
});
