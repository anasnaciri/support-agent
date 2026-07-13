import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  CustomerId,
  NetworkError,
  OrderId,
  PermissionServiceDefault,
  TenantId,
  ToolRegistryWith,
  type AgentConfig,
  type LLMDecision,
  type ShopifyOrder,
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

// A terminal (non-autonomous, no-handoff) agent: a bare final_message would
// normally RESOLVE the ticket. Used to prove the tracking-destination guard
// parks such a ticket for a human instead when the flag is set.
const terminalTrackingAgent: AgentConfig = {
  ...trackingAgent,
  id: AgentId("terminal-tracking-agent"),
  autonomousLoop: false,
};

const settingsFixture = () =>
  new TenantSettings({
    notificationEmail: null,
    refundPolicy: defaultRefundPolicy,
    discountPolicy: defaultDiscountPolicy,
    retentionDays: 730,
    supplierEscalationSheet: null,
    legalAcceptance: null,
  });

const liveTracking = (destinationCountry: string | null) =>
  TrackingServiceTest({
    lookupByNumber: new Map([
      [
        "TRK-DEST",
        {
          kind: "live",
          carrier: "UPS",
          trackingNumber: "TRK-DEST",
          status: "in_transit",
          lastScan: {
            occurredAt: new Date("2026-07-07T06:28:13.000Z"),
            location: null,
            description: "In transit",
          },
          estimatedDeliveryAt: null,
          trackingUrl: "https://t.17track.net/en#nums=TRK-DEST",
          transitDays: 5,
          ...(destinationCountry !== null ? { destinationCountry } : {}),
        },
      ],
    ]),
  });

const runTerminalTrackingTick = async (
  seedContext: Record<string, unknown>,
  destinationCountry: string | null,
) => {
  const script: ReadonlyArray<LLMDecision> = [
    {
      type: "tool_call",
      callId: "track-1",
      tool: "tracking.lookup",
      input: { trackingNumber: "TRK-DEST", carrier: null },
    },
    { type: "final_message", text: "Tracking checked." },
  ];
  const env = Layer.mergeAll(
    TicketRepositoryTest,
    AuditLogServiceTest,
    ApprovalServiceTest,
    AgentResolverTest([terminalTrackingAgent]),
    ToolRegistryWith(ALL_TOOLS),
    PermissionServiceDefault,
    LLMServiceScripted(script),
    TransactionRunnerPassthrough,
    ShopifyServiceTest({}),
    ConversationServiceTest({}),
    PlatformMailServiceTest({}),
    TenantAgentOverridesServiceTest(),
    TenantRepositoryTest({
      settingsByTenant: new Map([[TENANT, settingsFixture()]]),
    }),
    Layer.succeed(ApprovalLinkConfig, {
      baseUrl: "https://api.test.example",
      signingKey: "test-signing-key",
      ttlMs: 60_000,
    }),
    liveTracking(destinationCountry),
  );
  const layer = Layer.merge(
    AgentRuntimeDefault.pipe(
      Layer.provide(Layer.merge(env, TicketAttachmentStoreTest())),
    ),
    env,
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const repo = yield* TicketRepository;
        const created = yield* repo.create({
          tenantId: TENANT,
          channel: "email",
          currentAgentId: terminalTrackingAgent.id,
          subject: "Where is my order?",
          context: seedContext,
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

  it("stamps tracking_destination_mismatch and parks when the carrier destination differs from the order's ship country", async () => {
    const out = await runTerminalTrackingTick(
      { orderShipCountry: "United States" },
      "Germany",
    );
    expect(out.context["riskFlags"]).toContain("tracking_destination_mismatch");
    // A terminal agent's bare final_message would normally resolve — the guard
    // parks it for a human instead (mirrors the unverified-identity gate).
    expect(out.status).toBe("human_takeover");
  });

  it("does not flag or park when the carrier destination matches the order's ship country", async () => {
    const out = await runTerminalTrackingTick(
      { orderShipCountry: "United States" },
      "united states",
    );
    const flags = Array.isArray(out.context["riskFlags"])
      ? (out.context["riskFlags"] as unknown[])
      : [];
    expect(flags).not.toContain("tracking_destination_mismatch");
    expect(out.status).toBe("resolved");
  });

  it("does not flag when the order's ship country is unknown (fail open)", async () => {
    const out = await runTerminalTrackingTick({}, "Germany");
    const flags = Array.isArray(out.context["riskFlags"])
      ? (out.context["riskFlags"] as unknown[])
      : [];
    expect(flags).not.toContain("tracking_destination_mismatch");
    expect(out.status).toBe("resolved");
  });

  it("stamps orderShipCountry from shopify.get_order, then flags a mismatched tracking lookup", async () => {
    const orderId = OrderId("gid://shopify/Order/9001");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#9001",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/1"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "10.00", currencyCode: "EUR" },
      shippingAddress: {
        name: "A Customer",
        address1: "1 Berlin Str",
        address2: null,
        city: "Berlin",
        province: null,
        country: "Germany",
        zip: "10115",
        phone: null,
      },
      lineItems: [],
      fulfillments: [],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "o1",
        tool: "shopify.get_order",
        input: { orderId: "gid://shopify/Order/9001" },
      },
      {
        type: "tool_call",
        callId: "track-1",
        tool: "tracking.lookup",
        input: { trackingNumber: "TRK-DEST", carrier: null },
      },
      { type: "final_message", text: "Checked." },
    ];
    const getOrderAgent: AgentConfig = {
      ...terminalTrackingAgent,
      id: AgentId("get-order-tracking-agent"),
      tools: ["shopify.get_order", "tracking.lookup"],
    };
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([getOrderAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, settingsFixture()]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      liveTracking("United States"),
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(
        Layer.provide(Layer.merge(env, TicketAttachmentStoreTest())),
      ),
      env,
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: getOrderAgent.id,
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
    expect(out.context["orderShipCountry"]).toBe("Germany");
    expect(out.context["riskFlags"]).toContain("tracking_destination_mismatch");
    expect(out.status).toBe("human_takeover");
  });

  // Regression: prod ticket 03649e6f (2026-07-12). A supplier reship synced
  // via `order.update_tracking` replaced the fulfillment's number on Shopify,
  // but the liveTrackingStatus snapshot (old number + its exception scan)
  // stayed on the ticket forever — misleading both the dashboard Tracking
  // card and every later agent tick's facts header.
  it("clears a superseded liveTrackingStatus when order.update_tracking replaces the number", async () => {
    const orderId = OrderId("gid://shopify/Order/7001");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7001",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/1"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "10.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [],
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "in_transit",
          trackingCompany: "USPS",
          trackingNumbers: ["OLD123"],
          trackingUrls: [],
          estimatedDeliveryAt: null,
          deliveredAt: null,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "upd-1",
        tool: "order.update_tracking",
        input: {
          orderId: "gid://shopify/Order/7001",
          trackingNumber: "NEW456",
          trackingCompany: null,
          currentTrackingNumber: "OLD123",
        },
      },
      { type: "final_message", text: "Tracking synced." },
    ];
    const updateAgent: AgentConfig = {
      ...trackingAgent,
      id: AgentId("update-tracking-agent"),
      tools: ["order.update_tracking"],
    };
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([updateAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, settingsFixture()]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      liveTracking(null),
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(
        Layer.provide(Layer.merge(env, TicketAttachmentStoreTest())),
      ),
      env,
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: updateAgent.id,
            subject: "Where is my order?",
            context: {
              scenarioKey: "delivery_issue",
              liveTrackingStatus: {
                kind: "live",
                trackingNumber: "OLD123",
                carrier: "191997",
                status: "exception",
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
              bodyText: "Any update?",
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
    // The snapshot described the replaced number — it must not survive.
    expect(out.context["liveTrackingStatus"]).toBeUndefined();
    // Unrelated context is untouched.
    expect(out.context["scenarioKey"]).toBe("delivery_issue");
  });

  it("keeps liveTrackingStatus when order.update_tracking re-stores the same number", async () => {
    const orderId = OrderId("gid://shopify/Order/7002");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7002",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/1"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "10.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [],
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "in_transit",
          trackingCompany: "USPS",
          trackingNumbers: ["SAME789"],
          trackingUrls: [],
          estimatedDeliveryAt: null,
          deliveredAt: null,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "upd-1",
        tool: "order.update_tracking",
        input: {
          orderId: "gid://shopify/Order/7002",
          trackingNumber: "SAME789",
          trackingCompany: "USPS",
          currentTrackingNumber: "SAME789",
        },
      },
      { type: "final_message", text: "Tracking synced." },
    ];
    const updateAgent: AgentConfig = {
      ...trackingAgent,
      id: AgentId("update-tracking-agent-same"),
      tools: ["order.update_tracking"],
    };
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([updateAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, settingsFixture()]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      liveTracking(null),
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(
        Layer.provide(Layer.merge(env, TicketAttachmentStoreTest())),
      ),
      env,
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: updateAgent.id,
            subject: "Where is my order?",
            context: {
              liveTrackingStatus: {
                kind: "live",
                trackingNumber: "SAME789",
                carrier: "191997",
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
              bodyText: "Any update?",
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
    // Same number re-stored → the snapshot still describes the live number.
    expect(out.context["liveTrackingStatus"]).toMatchObject({
      trackingNumber: "SAME789",
    });
  });

  // Out-of-band edit (e.g. the merchant changes the fulfillment's tracking
  // number in the Shopify admin — no webhook exists): the next agent run that
  // reads the order must notice its liveTrackingStatus snapshot names a
  // number the order no longer tracks under and drop it, so the facts header
  // stops describing the superseded shipment even when the agent never calls
  // tracking.lookup in that run.
  it("clears a superseded liveTrackingStatus when shopify.get_order shows the order tracks under a new number", async () => {
    const orderId = OrderId("gid://shopify/Order/7003");
    const fixtureOrder: ShopifyOrder = {
      id: orderId,
      name: "#7003",
      confirmationNumber: null,
      email: "cust@example.com",
      customerId: CustomerId("gid://shopify/Customer/1"),
      fulfillmentStatus: "in_transit",
      financialStatus: "paid",
      totalPrice: { amount: "10.00", currencyCode: "USD" },
      shippingAddress: null,
      lineItems: [],
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "in_transit",
          trackingCompany: "USPS",
          trackingNumbers: ["NEW456"],
          trackingUrls: [],
          estimatedDeliveryAt: null,
          deliveredAt: null,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const script: ReadonlyArray<LLMDecision> = [
      {
        type: "tool_call",
        callId: "o1",
        tool: "shopify.get_order",
        input: { orderId: "gid://shopify/Order/7003" },
      },
      { type: "final_message", text: "Checked." },
    ];
    const getOrderAgent: AgentConfig = {
      ...trackingAgent,
      id: AgentId("get-order-heal-agent"),
      tools: ["shopify.get_order"],
    };
    const env = Layer.mergeAll(
      TicketRepositoryTest,
      AuditLogServiceTest,
      ApprovalServiceTest,
      AgentResolverTest([getOrderAgent]),
      ToolRegistryWith(ALL_TOOLS),
      PermissionServiceDefault,
      LLMServiceScripted(script),
      TransactionRunnerPassthrough,
      ShopifyServiceTest({ orders: new Map([[orderId, fixtureOrder]]) }),
      ConversationServiceTest({}),
      PlatformMailServiceTest({}),
      TenantAgentOverridesServiceTest(),
      TenantRepositoryTest({
        settingsByTenant: new Map([[TENANT, settingsFixture()]]),
      }),
      Layer.succeed(ApprovalLinkConfig, {
        baseUrl: "https://api.test.example",
        signingKey: "test-signing-key",
        ttlMs: 60_000,
      }),
      liveTracking(null),
    );
    const layer = Layer.merge(
      AgentRuntimeDefault.pipe(
        Layer.provide(Layer.merge(env, TicketAttachmentStoreTest())),
      ),
      env,
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const repo = yield* TicketRepository;
          const created = yield* repo.create({
            tenantId: TENANT,
            channel: "email",
            currentAgentId: getOrderAgent.id,
            subject: "Where is my order?",
            context: {
              identifiedOrderId: "gid://shopify/Order/7003",
              liveTrackingStatus: {
                kind: "live",
                trackingNumber: "OLD123",
                carrier: "191997",
                status: "exception",
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
              bodyText: "Any update?",
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
    // The order binding itself is untouched.
    expect(out.context["identifiedOrderId"]).toBe("gid://shopify/Order/7003");
  });
});
