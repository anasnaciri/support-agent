import { describe, expect, it } from "vitest";
import {
  orderContextRef,
  orderCustomerMismatchFlag,
  replyProvesOrderIdentity,
  shouldForceReplyApproval,
} from "../src/agent-runtime.js";

describe("orderContextRef", () => {
  it("prefers a numeric order name (dashboard resolves it via findOrderByName and it reads cleanly)", () => {
    expect(
      orderContextRef({ id: "gid://shopify/Order/55501", name: "#5501" }),
    ).toBe("#5501");
  });

  it("accepts a bare numeric name without the leading #", () => {
    expect(
      orderContextRef({ id: "gid://shopify/Order/55501", name: "5501" }),
    ).toBe("5501");
  });

  it("falls back to the GID when the name is non-numeric (a custom name would misroute to the confirmation-number lookup)", () => {
    expect(
      orderContextRef({ id: "gid://shopify/Order/55501", name: "EN-5501" }),
    ).toBe("gid://shopify/Order/55501");
  });

  it("falls back to the GID when the name is missing or blank", () => {
    expect(orderContextRef({ id: "gid://shopify/Order/55501" })).toBe(
      "gid://shopify/Order/55501",
    );
    expect(
      orderContextRef({ id: "gid://shopify/Order/55501", name: "  " }),
    ).toBe("gid://shopify/Order/55501");
  });

  it("returns null when neither a usable name nor id is present", () => {
    expect(orderContextRef({})).toBeNull();
    expect(orderContextRef({ id: "", name: "" })).toBeNull();
  });
});

describe("orderCustomerMismatchFlag", () => {
  it("flags when the order's customer email differs from the case customer", () => {
    expect(
      orderCustomerMismatchFlag("victim@example.com", {
        customerEmail: "asker@somewhere.com",
      }),
    ).toBe("order_customer_mismatch");
  });

  it("does not flag when the emails match (case-insensitive, trimmed)", () => {
    expect(
      orderCustomerMismatchFlag(" Victim@Example.com ", {
        customerEmail: "victim@example.com",
      }),
    ).toBeNull();
  });

  it("fails open (null) when the case has no known customer email", () => {
    expect(
      orderCustomerMismatchFlag("victim@example.com", {}),
    ).toBeNull();
  });

  it("fails open (null) when the order has no customer email", () => {
    expect(
      orderCustomerMismatchFlag(null, { customerEmail: "asker@somewhere.com" }),
    ).toBeNull();
    expect(
      orderCustomerMismatchFlag("", { customerEmail: "asker@somewhere.com" }),
    ).toBeNull();
  });
});

describe("replyProvesOrderIdentity", () => {
  const orderEmail = "victim@example.com";

  it("passes when the reply states the order's email", () => {
    expect(
      replyProvesOrderIdentity(
        "Sure — I placed it under victim@example.com.",
        orderEmail,
      ),
    ).toBe(true);
  });

  it("matches case-insensitively and ignores trailing punctuation", () => {
    expect(
      replyProvesOrderIdentity("It was Victim@Example.COM!", orderEmail),
    ).toBe(true);
  });

  it("matches an email wrapped in angle brackets", () => {
    expect(
      replyProvesOrderIdentity("From <victim@example.com>", orderEmail),
    ).toBe(true);
  });

  it("fails when the reply states a different email", () => {
    expect(
      replyProvesOrderIdentity("I used asker@somewhere.com", orderEmail),
    ).toBe(false);
  });

  it("fails when the reply contains no email", () => {
    expect(
      replyProvesOrderIdentity("yes that's my order, thanks", orderEmail),
    ).toBe(false);
  });

  it("fails open (false) on missing inputs", () => {
    expect(replyProvesOrderIdentity(null, orderEmail)).toBe(false);
    expect(replyProvesOrderIdentity("victim@example.com", null)).toBe(false);
  });
});

describe("shouldForceReplyApproval", () => {
  const flagged = {
    classification: "where_is_order",
    riskFlags: ["order_customer_mismatch"],
  };

  it("forces approval for a reply on an unverified mismatch where_is_order case", () => {
    expect(shouldForceReplyApproval("conversation.reply", flagged)).toBe(true);
  });

  it("does not force once identity is verified", () => {
    expect(
      shouldForceReplyApproval("conversation.reply", {
        ...flagged,
        identityVerified: true,
      }),
    ).toBe(false);
  });

  it("does not force when there is no mismatch flag", () => {
    expect(
      shouldForceReplyApproval("conversation.reply", {
        classification: "where_is_order",
        riskFlags: [],
      }),
    ).toBe(false);
  });

  it("does not force outside the where_is_order flow", () => {
    expect(
      shouldForceReplyApproval("conversation.reply", {
        classification: "refund_request",
        riskFlags: ["order_customer_mismatch"],
      }),
    ).toBe(false);
  });

  it("only forces the customer-facing reply tool", () => {
    expect(shouldForceReplyApproval("conversation.ask_customer", flagged)).toBe(
      false,
    );
    expect(shouldForceReplyApproval("shopify.get_order", flagged)).toBe(false);
  });
});
