import { describe, expect, it } from "vitest";
import { redactDetails, redactPii } from "../src/audit-redaction.js";

describe("redactPii — known-PII keys", () => {
  it("redacts string values under PII keys", () => {
    expect(
      redactPii({
        email: "alice@example.com",
        bodyText: "Hi, your order ships tomorrow.",
        finalMessage: "Thanks, here's your tracking 1Z999.",
        phone: "+1 415 555 0100",
        firstName: "Alice",
        lastName: "Doe",
      }),
    ).toEqual({
      email: "[redacted]",
      bodyText: "[redacted]",
      finalMessage: "[redacted]",
      phone: "[redacted]",
      firstName: "[redacted]",
      lastName: "[redacted]",
    });
  });

  it("redacts nested PII keys (recursive walk)", () => {
    expect(
      redactPii({
        from: { email: "alice@example.com", name: "Alice" },
        to: [
          { email: "support@store.com", phone: "+15555550100" },
          { email: "ops@store.com" },
        ],
      }),
    ).toEqual({
      from: { email: "[redacted]", name: "Alice" }, // `name` not in PII_KEYS — `firstName`/`lastName` are
      to: [
        { email: "[redacted]", phone: "[redacted]" },
        { email: "[redacted]" },
      ],
    });
  });

  it("leaves structural fields untouched", () => {
    expect(
      redactPii({
        tool: "conversation.reply",
        ok: true,
        turn: 3,
        callId: "c0",
        viaApprovalId: "appr_abc",
      }),
    ).toEqual({
      tool: "conversation.reply",
      ok: true,
      turn: 3,
      callId: "c0",
      viaApprovalId: "appr_abc",
    });
  });
});

describe("redactPii — regex scrubbing of free-text strings", () => {
  it("scrubs email patterns from non-PII-key strings", () => {
    const out = redactPii({
      reason: "Customer alice@example.com asked for a refund",
    });
    expect(out).toEqual({
      reason: "Customer [redacted] asked for a refund",
    });
  });

  it("scrubs phone patterns from non-PII-key strings", () => {
    const out = redactPii({
      notes: "Customer called +1 415 555 0100 yesterday",
    });
    expect(out).toEqual({
      notes: "Customer called [redacted] yesterday",
    });
  });

  it("scrubs both email and phone in the same string", () => {
    const out = redactPii({
      notes: "Reach alice@example.com or +1 415 555 0100",
    });
    expect(out).toEqual({
      notes: "Reach [redacted] or [redacted]",
    });
  });

  it("leaves strings without PII patterns alone", () => {
    expect(redactPii({ notes: "Order #1001 has shipped" })).toEqual({
      notes: "Order #1001 has shipped",
    });
  });
});

describe("redactPii — primitives + edge cases", () => {
  it("returns numbers / booleans / null unchanged", () => {
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
    expect(redactPii(null)).toBe(null);
  });

  it("returns a top-level string with regex scrubbing applied", () => {
    expect(redactPii("Hey alice@example.com")).toBe("Hey [redacted]");
  });

  it("handles empty / missing inputs", () => {
    expect(redactPii({})).toEqual({});
    expect(redactPii([])).toEqual([]);
    expect(redactPii(undefined)).toBeUndefined();
  });

  it("doesn't crash on circular-free deeply nested objects", () => {
    const deep = { a: { b: { c: { email: "x@y.com" } } } };
    expect(redactPii(deep)).toEqual({
      a: { b: { c: { email: "[redacted]" } } },
    });
  });
});

describe("redactDetails", () => {
  it("preserves the Readonly<Record<string, unknown>> contract", () => {
    const input: Readonly<Record<string, unknown>> = {
      tool: "conversation.reply",
      bodyText: "Hello Alice",
    };
    const out = redactDetails(input);
    expect(out["tool"]).toBe("conversation.reply");
    expect(out["bodyText"]).toBe("[redacted]");
  });
});
