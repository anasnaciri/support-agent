import { describe, expect, it } from "vitest";
import { parseGmailPushEnvelope } from "../src/gmail-webhook.js";

const makeEnvelope = (decodedPayload: Record<string, unknown>): Buffer => {
  const data = Buffer.from(JSON.stringify(decodedPayload), "utf8").toString(
    "base64",
  );
  return Buffer.from(
    JSON.stringify({
      message: {
        data,
        messageId: "pubsub-1",
        publishTime: "2026-05-17T00:00:00.000Z",
      },
      subscription: "projects/p/subscriptions/s",
    }),
    "utf8",
  );
};

describe("parseGmailPushEnvelope", () => {
  it("decodes a valid envelope", () => {
    const buf = makeEnvelope({
      emailAddress: "support@merchant.com",
      historyId: "12345",
    });
    const parsed = parseGmailPushEnvelope(buf);
    expect(parsed).toEqual({
      emailAddress: "support@merchant.com",
      historyId: "12345",
    });
  });

  it("returns null when the outer JSON is malformed", () => {
    expect(parseGmailPushEnvelope(Buffer.from("not json", "utf8"))).toBeNull();
  });

  it("returns null when message.data is missing", () => {
    const buf = Buffer.from(
      JSON.stringify({ message: { messageId: "x" } }),
      "utf8",
    );
    expect(parseGmailPushEnvelope(buf)).toBeNull();
  });

  it("returns null when inner payload is missing required fields", () => {
    const buf = makeEnvelope({ emailAddress: "support@merchant.com" });
    expect(parseGmailPushEnvelope(buf)).toBeNull();
  });

  it("returns null when inner payload isn't valid JSON", () => {
    const data = Buffer.from("not json", "utf8").toString("base64");
    const buf = Buffer.from(
      JSON.stringify({ message: { data } }),
      "utf8",
    );
    expect(parseGmailPushEnvelope(buf)).toBeNull();
  });
});
