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
  decodeResolutionPolicyUpdate,
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
    retentionDays: 365,
    supplierEscalationSheet: null,
    legalAcceptance: null,
    ...overrides,
  });

describe("TenantRepositoryTest", () => {
  it("uses a new data-processing notice version for the retention policy change", () => {
    expect(DATA_PROCESSING_NOTICE_VERSION).toBe("2026-07-04");
  });

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

  it("setCancellationRestock replaces the flag (preserves refundPolicy)", async () => {
    const initial = settings({ cancellationRestock: true });
    const layer = TenantRepositoryTest({
      settingsByTenant: new Map([[tenantId, initial]]),
    });
    const got = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const repo = yield* TenantRepository;
          yield* repo.setCancellationRestock(tenantId, false);
          return yield* repo.getSettings(tenantId);
        }),
        layer,
      ),
    );
    expect(got.cancellationRestock).toBe(false);
    expect(got.refundPolicy).toEqual(defaultRefundPolicy);
    expect(got.notificationEmail).toBe("ops@example.com");
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
    // No `enabled` in the raw → defaults to enabled (back-compat).
    expect(p.scenarios[0]!.enabled).toBe(true);
  });

  it("respects an explicit enabled:false and defaults absent enabled to true", () => {
    const raw = {
      scenarios: [
        {
          key: "off_one",
          label: "Off",
          builtin: false,
          enabled: false,
          enabledActions: [],
          supplierMode: "none",
        },
        {
          key: "on_one",
          label: "On",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    };
    const p = decodeResolutionPolicy(raw);
    expect(p.scenarios.find((s) => s.key === "off_one")!.enabled).toBe(false);
    expect(p.scenarios.find((s) => s.key === "on_one")!.enabled).toBe(true);
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

describe("order_cancellation built-in scenario", () => {
  const cancel = defaultResolutionPolicy.scenarios.find(
    (s) => s.key === "order_cancellation",
  );

  it("ships as a built-in with order.cancel gated by approval", () => {
    expect(cancel).toBeDefined();
    expect(cancel!.builtin).toBe(true);
    expect(cancel!.enabled).toBe(true);
    expect(cancel!.supplierMode).toBe("none");
    expect(cancel!.enabledActions).toEqual([
      { tool: "order.cancel", permission: "ask" },
    ]);
  });

  it("survives the write-path normalizer as a forced built-in", () => {
    // A merchant can't delete it or strip its remedy by omission; the write
    // decoder re-seeds every built-in.
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    const out = p.scenarios.find((s) => s.key === "order_cancellation");
    expect(out).toBeDefined();
    expect(out!.builtin).toBe(true);
  });
});

describe("decodeResolutionPolicyUpdate (write-path normalizer)", () => {
  const builtinKeys = defaultResolutionPolicy.scenarios.map((s) => s.key);

  it("always keeps every built-in present, even when the body omits them", () => {
    const p = decodeResolutionPolicyUpdate({ scenarios: [] });
    expect(p.scenarios.map((s) => s.key)).toEqual(builtinKeys);
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
  });

  it("forces built-in immutable fields (key/label/recognition/builtin) from defaults", () => {
    const def = defaultResolutionPolicy.scenarios[0]!;
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          // A merchant tries to rename a built-in + flip its builtin flag.
          key: def.key,
          label: "Hacked label",
          recognition: "Hacked recognition",
          builtin: false,
          enabled: false,
          enabledActions: [{ tool: "refund.create", permission: "allow" }],
          supplierMode: "notify_and_proceed",
          notes: "merchant note",
        },
      ],
    });
    const out = p.scenarios.find((s) => s.key === def.key)!;
    // Immutable fields are restored from the seeded defaults …
    expect(out.label).toBe(def.label);
    expect(out.recognition).toBe(def.recognition);
    expect(out.builtin).toBe(true);
    // … while the editable fields are taken from the body.
    expect(out.enabled).toBe(false);
    expect(out.enabledActions).toEqual([
      { tool: "refund.create", permission: "allow" },
    ]);
    expect(out.supplierMode).toBe("notify_and_proceed");
    expect(out.notes).toBe("merchant note");
  });

  it("accepts a custom scenario, forcing builtin:false and namespacing its key", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "VIP Complaint!", // unsanitized
          label: "VIP complaint",
          recognition: "An angry high-value customer",
          builtin: true, // lie — must be coerced to false
          enabled: true,
          enabledActions: [{ tool: "discount.create", permission: "ask" }],
          supplierMode: "none",
          notes: "Be gracious.",
        },
      ],
    });
    const custom = p.scenarios.find((s) => !s.builtin)!;
    expect(custom.builtin).toBe(false);
    expect(custom.key).toBe("custom_vip_complaint");
    expect(custom.label).toBe("VIP complaint");
    expect(custom.recognition).toBe("An angry high-value customer");
    expect(custom.enabledActions).toEqual([
      { tool: "discount.create", permission: "ask" },
    ]);
    // Built-ins still come along.
    expect(p.scenarios.filter((s) => s.builtin).map((s) => s.key)).toEqual(
      builtinKeys,
    );
  });

  it("derives a custom key from the label when none is supplied", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Wholesale order question",
          recognition: "B2B / bulk buyer asking about an order",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    });
    expect(p.scenarios.find((s) => !s.builtin)!.key).toBe(
      "custom_wholesale_order_question",
    );
  });

  it("dedupes colliding custom keys and never clobbers a built-in", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Returns",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
        {
          key: "",
          label: "Returns",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
        {
          // Tries to masquerade as a built-in via a custom_ key.
          key: "custom_where_is_order",
          label: "Sneaky",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    });
    const customKeys = p.scenarios.filter((s) => !s.builtin).map((s) => s.key);
    expect(customKeys).toEqual([
      "custom_returns",
      "custom_returns_2",
      "custom_where_is_order",
    ]);
    // The real built-in is untouched + distinct.
    expect(p.scenarios.find((s) => s.key === "where_is_order")!.builtin).toBe(
      true,
    );
  });

  it("keeps a stable existing custom key across an edit (no re-slug from label)", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "custom_vip_complaint", // already-assigned key round-tripped
          label: "VIP escalation", // renamed
          recognition: "angry whale",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    });
    expect(p.scenarios.find((s) => !s.builtin)!.key).toBe("custom_vip_complaint");
  });

  it("drops a custom scenario with a blank label", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "   ",
          builtin: false,
          enabledActions: [],
          supplierMode: "none",
        },
      ],
    });
    expect(p.scenarios.every((s) => s.builtin)).toBe(true);
  });

  it("defaults a custom's invalid supplierMode to none and drops invalid actions", () => {
    const p = decodeResolutionPolicyUpdate({
      scenarios: [
        {
          key: "",
          label: "Odd one",
          builtin: false,
          enabledActions: [
            { tool: "refund.create", permission: "ask" },
            { tool: 7, permission: "allow" },
          ],
          supplierMode: "whenever",
        },
      ],
    });
    const custom = p.scenarios.find((s) => !s.builtin)!;
    expect(custom.supplierMode).toBe("none");
    expect(custom.enabledActions).toEqual([
      { tool: "refund.create", permission: "ask" },
    ]);
  });

  it("falls back to all built-ins on a wholly malformed body", () => {
    expect(decodeResolutionPolicyUpdate(42).scenarios.map((s) => s.key)).toEqual(
      builtinKeys,
    );
    expect(
      decodeResolutionPolicyUpdate({ scenarios: "nope" }).scenarios.every(
        (s) => s.builtin,
      ),
    ).toBe(true);
  });
});
