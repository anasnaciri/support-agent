import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  NetworkError,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type AgentConfig,
  type LLMDecision,
} from "@support-agent/agent-core";
import { ALL_TOOLS } from "../../tools/src/index.js";
import {
  AgentResolverTest,
  AgentRuntime,
  AgentRuntimeDefault,
  TicketAttachmentStoreTest,
  ApprovalLinkConfig,
  ApprovalServiceTest,
  AuditLogServiceTest,
  ConversationServiceTest,
  LLMServiceScripted,
  PlatformMailServiceTest,
  ShopifyServiceTest,
  TenantAgentOverridesServiceTest,
  TenantRepositoryTest,
  TenantSettings,
  TicketRepository,
  TicketRepositoryTest,
  TrackingServiceTest,
  TransactionRunnerPassthrough,
  defaultDiscountPolicy,
  defaultRefundPolicy,
} from "../src/index.js";

const TENANT = TenantId("tenant-acme");

const trackingAgent: AgentConfig = {
  id: AgentId("tracking-agent"),
  name: "Tracking Agent",
  description: "test tracking agent",
  mode: "subagent",
  provider: "openrouter",
  model: "google/gemini-3.5-flash",
  autonomousLoop: true,
  promptTemplate: "test",
  tools: ["tracking.lookup"],
  permissionOverrides: {},
  handoffs: [],
  maxTurnsPerTick: 5,
  temperature: 0,
};

describe("AgentRuntime tracking.lookup side effects", () => {
  it("stamps liveTrackingStatus after tracking.lookup even when the agent does not call ticket.update_context", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "track-1",
        tool: "tracking.lookup",
        input: { trackingNumber: "LZ408772868CN", carrier: null },
      },
      { type: "final_message", text: "Tracking checked." },
    ];

    const tenantSettings = new TenantSettings({
      notificationEmail: null,
      refundPolicy: defaultRefundPolicy,
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 730,
      supplierEscalationSheet: null,
      legalAcceptance: null,
    });
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([trackingAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, tenantSettings]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      TrackingServiceTest({
        lookupByNumber: new Map([
          [
            "LZ408772868CN",
            {
              kind: "live",
              carrier: "3011",
              trackingNumber: "LZ408772868CN",
              status: "exception",
              lastScan: {
                occurredAt: new Date("2026-07-07T06:28:13.000Z"),
                location: null,
                description:
                  "DEVOLUCION, Finalizado plazo retirada, Devolución del envío por finalización de plazo de retirada",
              },
              estimatedDeliveryAt: null,
              trackingUrl: "https://t.17track.net/en#nums=LZ408772868CN",
              transitDays: 60,
            },
          ],
        ]),
      }),
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: trackingAgent.id,
            subject: "Where is my order?",
          });
          yield* runtime.handleEvent({
            type: "customer.replied",
            ticketId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Where is my order?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          return yield* repo.getById(created.id);
        }),
        layer,
      ),
    );

    expect(out.context["liveTrackingStatus"]).toMatchObject({
      kind: "live",
      carrier: "3011",
      trackingNumber: "LZ408772868CN",
      status: "exception",
    });
  });

  it("clears stale liveTrackingStatus when tracking.lookup fails", async () => {
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "track-1",
        tool: "tracking.lookup",
        input: { trackingNumber: "NEW123", carrier: null },
      },
      { type: "final_message", text: "Tracking checked." },
    ];

    const tenantSettings = new TenantSettings({
      notificationEmail: null,
      refundPolicy: defaultRefundPolicy,
      discountPolicy: defaultDiscountPolicy,
      retentionDays: 730,
      supplierEscalationSheet: null,
      legalAcceptance: null,
    });
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([trackingAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({}),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, tenantSettings]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      TrackingServiceTest({
        lookup: () => Effect.fail(new NetworkError({ cause: "boom" })),
      }),
    );
    const layer = Layer.merge(AgentRuntimeDefault.pipe(Layer.provide(Layer.merge(env, TicketAttachmentStoreTest()))), env);

    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: trackingAgent.id,
            subject: "Where is my order?",
            context: {
              liveTrackingStatus: {
                kind: "live",
                trackingNumber: "OLD123",
                carrier: "old",
                status: "in_transit",
              },
            },
          });
          yield* runtime.handleEvent({
            type: "customer.replied",
            ticketId: created.id,
            payload: {
              threadId: "thread-x" as never,
              messageId: "msg-1",
              from: { name: null, email: "cust@example.com" },
              to: [],
              subject: "Re: Where is my order?",
              bodyText: "Where is my order?",
              bodyHtml: null,
              receivedAt: new Date(),
              attachments: [],
            },
          });
          return yield* repo.getById(created.id);
        }),
        layer,
      ),
    );

    expect(out.context["liveTrackingStatus"]).toBeUndefined();
  });
});
