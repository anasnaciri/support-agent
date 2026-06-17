import { describe, expect, it } from "vitest";
import {
  orderCustomerMismatchFlag,
  replyProvesOrderIdentity,
  shouldForceReplyApproval,
} from "../src/agent-runtime.js";

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
