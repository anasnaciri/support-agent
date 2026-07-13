import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalId,
  TenantId,
} from "@support-agent/agent-core";
import {
  DEFAULT_RETENTION_DAYS,
  PlatformMailSendFailed,
  PlatformMailService,
  PlatformMailUnconfigured,
  TenantNotFound,
  TenantRepository,
  TenantSettings,
  defaultRefundPolicy,
  defaultDiscountPolicy,
} from "@support-agent/services";
import {
  PlatformMailServiceLive,
  ResendConfig,
  renderFulfillmentOperatorEscalationEmail,
} from "../src/platform-mail-live.js";

const okResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => '{"id":"resend-123"}',
    json: async () => ({ id: "resend-123" }),
  }) as unknown as Response;

const failResponse = (status: number, body = ""): Response =>
  ({
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  }) as unknown as Response;

const tenantId = TenantId("11111111-1111-1111-1111-111111111111");
const approvalId = ApprovalId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

const sendInput = {
  tenantId,
  approvalId,
  draftSubject: "Refund for #1001",
  draftPreview:
    "Hi Jane, thanks for reaching out about order #1001. We can process a refund on receipt.",
  toolName: "conversation.reply",
  approveUrl: "https://api.example.com/approvals/x/approve?token=A",
  rejectUrl: "https://api.example.com/approvals/x/reject?token=R",
};

const tenantRepoWith = (
  notificationEmail: string | null,
): Layer.Layer<TenantRepository> =>
  Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: () =>
        Effect.succeed(
          new TenantSettings({
            notificationEmail,
            refundPolicy: defaultRefundPolicy,
            discountPolicy: defaultDiscountPolicy,
            retentionDays: DEFAULT_RETENTION_DAYS,
            fulfillmentOperatorEscalationSheet: null,
            legalAcceptance: null,
          }),
        ),
      setRefundPolicy: () => Effect.void,
      setFulfillmentOperatorEscalationSheet: () => Effect.void,
      setLegalAcceptance: () => Effect.void,
    }),
  );

const tenantRepoMissing = (): Layer.Layer<TenantRepository> =>
  Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: () => Effect.fail(new TenantNotFound({ tenantId })),
      setRefundPolicy: () => Effect.fail(new TenantNotFound({ tenantId })),
      setFulfillmentOperatorEscalationSheet: () =>
        Effect.fail(new TenantNotFound({ tenantId })),
      setLegalAcceptance: () => Effect.fail(new TenantNotFound({ tenantId })),
    }),
  );

const resendConfigWith = (
  fetchImpl: typeof fetch,
): Layer.Layer<ResendConfig> =>
  Layer.succeed(
    ResendConfig,
    {
      apiKey: "re_test_key",
      fromAddress: "Support Agent <notifications@platform.test>",
      fetchImpl,
    },
  );

describe("PlatformMailServiceLive — Resend", () => {
  it("POSTs to Resend with the recipient resolved from tenant settings", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse());
    const layer = PlatformMailServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          tenantRepoWith("ops@merchant.com"),
          resendConfigWith(fetchImpl),
        ),
      ),
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mail = yield* PlatformMailService;
          yield* mail.sendApprovalLink(sendInput);
        }),
        layer,
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init!.body as string) as {
      from: string;
      to: ReadonlyArray<string>;
      subject: string;
      text: string;
      html: string;
    };
    expect(body.from).toBe("Support Agent <notifications@platform.test>");
    expect(body.to).toEqual(["ops@merchant.com"]);
    expect(body.subject).toContain("Refund for #1001");
    expect(body.text).toContain(sendInput.approveUrl);
    expect(body.text).toContain(sendInput.rejectUrl);
    expect(body.text).toContain(sendInput.draftPreview);
    expect(body.html).toContain(sendInput.approveUrl);
    expect(body.html).toContain(sendInput.rejectUrl);
  });

  it("fails with PlatformMailUnconfigured when notificationEmail is null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse());
    const layer = PlatformMailServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(tenantRepoWith(null), resendConfigWith(fetchImpl)),
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mail = yield* PlatformMailService;
          return yield* Effect.either(mail.sendApprovalLink(sendInput));
        }),
        layer,
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PlatformMailUnconfigured);
    }
    // No call to Resend.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps Resend non-2xx into PlatformMailSendFailed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(failResponse(422, '{"message":"invalid from"}'));
    const layer = PlatformMailServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          tenantRepoWith("ops@merchant.com"),
          resendConfigWith(fetchImpl),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mail = yield* PlatformMailService;
          return yield* Effect.either(mail.sendApprovalLink(sendInput));
        }),
        layer,
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PlatformMailSendFailed);
    }
  });

  it("sendAccountDeleted POSTs to the recipient passed in directly (no tenant lookup)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    // tenantRepoMissing would FAIL if sendAccountDeleted tried to resolve the
    // recipient via the repo — proves the recipient comes from the input.
    const layer = PlatformMailServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(tenantRepoMissing(), resendConfigWith(fetchImpl)),
      ),
    );

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mail = yield* PlatformMailService;
          yield* mail.sendAccountDeleted({
            tenantId,
            tenantName: "Acme Co",
            recipientEmail: "owner@acme.com",
          });
        }),
        layer,
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init!.body as string) as {
      to: ReadonlyArray<string>;
      subject: string;
      text: string;
    };
    expect(body.to).toEqual(["owner@acme.com"]);
    expect(body.subject).toContain("Acme Co");
    expect(body.text).toContain("deleted");
    // Stable Idempotency-Key so a retried/duplicate cleanup job can't send
    // the deletion email twice (re-audit #2).
    const headers = init!.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`account-deleted:${tenantId}`);
  });

  it("maps TenantNotFound to PlatformMailSendFailed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const layer = PlatformMailServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(tenantRepoMissing(), resendConfigWith(fetchImpl)),
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const mail = yield* PlatformMailService;
          return yield* Effect.either(mail.sendApprovalLink(sendInput));
        }),
        layer,
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(PlatformMailSendFailed);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("renderFulfillmentOperatorEscalationEmail (copy builder)", () => {
  it("includes the portal link, the order ref, and the problem — but no customer PII", () => {
    const { subject, text, html } = renderFulfillmentOperatorEscalationEmail({
      tenantId,
      escalationId: "esc-1",
      fulfillmentOperatorEmail: "wh@acme.com",
      portalUrl: "https://app.example.com/fulfillment-operator/tickets/esc-1",
      problem: "Order #1001 to Berlin, DE is stuck — please chase or reship",
      orderRef: "#1001",
    });
    expect(subject).toContain("#1001");
    expect(text).toContain("https://app.example.com/fulfillment-operator/tickets/esc-1");
    expect(text).toContain("please chase or reship");
    expect(html).toContain("https://app.example.com/fulfillment-operator/tickets/esc-1");
    // The input never carries customer data; assert nothing leaked in anyway.
    expect(text).not.toContain("@example.com");
    expect(`${subject}${text}${html}`.toLowerCase()).not.toContain("customer email");
  });

  it("falls back to a generic call-to-action when no portal URL is configured", () => {
    const { text } = renderFulfillmentOperatorEscalationEmail({
      tenantId,
      escalationId: "esc-2",
      fulfillmentOperatorEmail: "wh@acme.com",
      portalUrl: null,
      problem: "Stuck order",
      orderRef: null,
    });
    expect(text).toContain("Log in to your fulfillment partner portal");
    expect(text).not.toContain("/fulfillment-operator/tickets/");
  });
});
