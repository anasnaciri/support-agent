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
} from "@support-agent/services";
import {
  PlatformMailServiceLive,
  ResendConfig,
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
    "Hi Jane — thanks for reaching out about order #1001. We can process a refund on receipt.",
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
            retentionDays: DEFAULT_RETENTION_DAYS,
          }),
        ),
      setRefundPolicy: () => Effect.void,
    }),
  );

const tenantRepoMissing = (): Layer.Layer<TenantRepository> =>
  Layer.succeed(
    TenantRepository,
    TenantRepository.of({
      getSettings: () => Effect.fail(new TenantNotFound({ tenantId })),
      setRefundPolicy: () => Effect.fail(new TenantNotFound({ tenantId })),
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
