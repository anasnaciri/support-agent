import { describe, expect, it } from "vitest";
import {
  CaseId,
  ThreadId,
  type DomainEvent,
} from "@support-agent/agent-core";
import { buildInitialMessages } from "../src/agent-runtime.js";

const textOf = (messages: ReturnType<typeof buildInitialMessages>): string => {
  expect(messages).toHaveLength(1);
  const content = messages[0]!.content;
  expect(typeof content).toBe("string");
  return content as string;
};

describe("buildInitialMessages — case.resumed (dashboard retry)", () => {
  const resumed: DomainEvent = {
    type: "case.resumed",
    caseId: CaseId("c-1"),
    trigger: "dashboard_retry",
  };

  it("gives the agent the thread id, trigger, subject, and prior context", () => {
    const text = textOf(
      buildInitialMessages(resumed, {
        subject: "Where is my order?",
        threadId: ThreadId("outlook:AAMk-thread-9"),
        context: { identifiedOrderId: "gid://shopify/Order/1001" },
      }),
    );
    // The agent must be able to wire conversation.* tools without guessing.
    expect(text).toContain("threadId=outlook:AAMk-thread-9");
    expect(text).toContain("case.resumed");
    expect(text).toContain("dashboard_retry");
    expect(text).toContain("Where is my order?");
    // Findings from the previous attempt (case.update_context patches).
    expect(text).toContain("gid://shopify/Order/1001");
    // It should be told to re-read the conversation before acting.
    expect(text).toContain("conversation.fetch_thread");
  });

  it("omits the thread header and fetch instruction when the case has no thread", () => {
    const text = textOf(
      buildInitialMessages(resumed, {
        subject: null,
        threadId: null,
        context: {},
      }),
    );
    expect(text).toContain("case.resumed");
    expect(text).toContain("dashboard_retry");
    expect(text).not.toContain("threadId=");
    expect(text).not.toContain("conversation.fetch_thread");
  });

  it("leaves other system events on the terse legacy shape", () => {
    const timer: DomainEvent = {
      type: "timer.expired",
      caseId: CaseId("c-1"),
      timerId: "t-1",
      reason: "follow_up",
    };
    const text = textOf(
      buildInitialMessages(timer, {
        subject: "Where is my order?",
        threadId: ThreadId("gmail:abc"),
        context: {},
      }),
    );
    expect(text).toBe("(system event: timer.expired)");
  });

  it("keeps message.received behavior (subject falls back to the case row)", () => {
    const event: DomainEvent = {
      type: "message.received",
      tenantId: "t1",
      threadId: "gmail:abc",
      payload: {
        messageId: "m-1",
        from: { name: "Jane", email: "jane@example.com" },
        subject: null,
        bodyText: "hello",
        receivedAt: new Date("2026-06-01T00:00:00Z"),
        attachments: [],
      },
    } as never;
    const text = textOf(
      buildInitialMessages(event, {
        subject: "Stored subject",
        threadId: ThreadId("gmail:abc"),
        context: {},
      }),
    );
    expect(text).toContain("Subject: Stored subject");
    expect(text).toContain("threadId=gmail:abc");
  });
});
