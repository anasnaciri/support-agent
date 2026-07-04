import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AgentId,
  TicketId,
  CustomerId,
  OrderId,
  TenantId,
  ToolName,
  type AgentId as AgentIdT,
  type TicketId as TicketIdT,
  type TenantId as TenantIdT,
} from "../src/index.js";

describe("branded ids", () => {
  it("constructors brand plain strings at runtime", () => {
    const t = TenantId("tenant_abc");
    const c = TicketId("ticket_123");
    expect(t).toBe("tenant_abc");
    expect(c).toBe("ticket_123");
  });

  it("brand types are distinct from string and from each other", () => {
    expectTypeOf<TenantIdT>().not.toEqualTypeOf<string>();
    expectTypeOf<TenantIdT>().not.toEqualTypeOf<TicketIdT>();
    expectTypeOf<TicketIdT>().not.toEqualTypeOf<AgentIdT>();
  });

  it("all branded constructors return their nominal type", () => {
    expectTypeOf(TenantId("x")).toEqualTypeOf<TenantIdT>();
    expectTypeOf(TicketId("x")).toEqualTypeOf<TicketIdT>();
    expectTypeOf(AgentId("x")).toEqualTypeOf<AgentIdT>();
    expectTypeOf(CustomerId("x")).toEqualTypeOf<ReturnType<typeof CustomerId>>();
    expectTypeOf(OrderId("x")).toEqualTypeOf<ReturnType<typeof OrderId>>();
    expectTypeOf(ToolName("x")).toEqualTypeOf<ReturnType<typeof ToolName>>();
  });
});
