import { describe, expect, it } from "vitest";
import { ThreadId } from "@support-agent/agent-core";
import {
  CONVERSATION_PROVIDERS,
  isConversationProvider,
  namespaceThreadId,
  parseThreadId,
} from "../src/conversation-thread-id.js";

describe("conversation thread-id namespacing", () => {
  it("namespaceThreadId prefixes the provider", () => {
    expect(namespaceThreadId("outlook", "AQQkADAw=")).toBe("outlook:AQQkADAw=");
    expect(namespaceThreadId("gmail", "19e9ad3a3f896575")).toBe(
      "gmail:19e9ad3a3f896575",
    );
  });

  it("parseThreadId round-trips namespaceThreadId", () => {
    for (const provider of CONVERSATION_PROVIDERS) {
      const parsed = parseThreadId(namespaceThreadId(provider, "raw-id"));
      expect(parsed).toEqual({ provider, raw: ThreadId("raw-id") });
    }
  });

  it("parseThreadId keeps colons in the raw id (only the first splits)", () => {
    // IMAP thread roots are RFC 5322 Message-IDs, which may contain colons.
    const parsed = parseThreadId("imap:<a:b@example.com>");
    expect(parsed).toEqual({
      provider: "imap",
      raw: ThreadId("<a:b@example.com>"),
    });
  });

  it("parseThreadId rejects an unknown provider prefix", () => {
    expect(parseThreadId("helpdesk:123")).toBeNull();
  });

  it("parseThreadId rejects an un-namespaced id", () => {
    expect(parseThreadId("19e9ad3a3f896575")).toBeNull();
  });

  it("parseThreadId rejects an empty raw id", () => {
    expect(parseThreadId("gmail:")).toBeNull();
  });

  it("isConversationProvider narrows the connector union", () => {
    expect(isConversationProvider("gmail")).toBe(true);
    expect(isConversationProvider("outlook")).toBe(true);
    expect(isConversationProvider("imap")).toBe(true);
    expect(isConversationProvider("shopify")).toBe(false);
    expect(isConversationProvider("openrouter")).toBe(false);
  });
});
