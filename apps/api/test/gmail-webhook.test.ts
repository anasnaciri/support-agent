import { describe, expect, it, vi } from "vitest";
import { Layer } from "effect";
import {
  BlobStorageTest,
  ConnectorCredentialStoreTest,
} from "@support-agent/services";
import { TenantId, type DomainEvent } from "@support-agent/agent-core";
import {
  backfillUnreadGmailInbox,
  parseGmailPushEnvelope,
} from "../src/gmail-webhook.js";

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

const b64url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

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

describe("backfillUnreadGmailInbox", () => {
  it("publishes existing unread INBOX messages after a Gmail mailbox is connected", async () => {
    const tenantId = TenantId("tenant-1");
    const mailbox = "support@merchant.com";
    const layer = Layer.mergeAll(
      ConnectorCredentialStoreTest([
        {
          tenantId,
          provider: "gmail",
          shopDomain: mailbox,
          accessToken: "tok",
          refreshToken: "refresh",
          tokenExpiresAt: new Date(Date.now() + 60_000),
          metadata: {},
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          apiVersion: null,
          installedAt: new Date("2026-06-02T00:00:00.000Z"),
          status: "active",
        },
      ]),
      BlobStorageTest({}),
    );
    const published: DomainEvent[] = [];
    const operations: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/users/me/messages?")) {
        operations.push("list");
        const parsed = new URL(u);
        expect(parsed.searchParams.get("q")).toBe("in:inbox is:unread");
        expect(parsed.searchParams.get("maxResults")).toBe("50");
        return okJson({
          messages: [
            { id: "m-unread", threadId: "t-1" },
            { id: "m-sent", threadId: "t-2" },
          ],
        });
      }
      if (u.includes("/users/me/messages/m-unread?")) {
        operations.push("get:m-unread");
        return okJson({
          id: "m-unread",
          threadId: "t-1",
          labelIds: ["INBOX", "UNREAD"],
          internalDate: "1770000000000",
          payload: {
            headers: [
              { name: "From", value: "jane@example.com" },
              { name: "To", value: mailbox },
              { name: "Subject", value: "Still waiting on order #1001" },
            ],
            body: { data: b64url("Can someone help with this?") },
          },
        });
      }
      if (u.includes("/users/me/messages/m-unread/modify")) {
        operations.push("mark-read:m-unread");
        return okJson({ id: "m-unread", labelIds: ["INBOX"] });
      }
      if (u.includes("/users/me/messages/m-sent?")) {
        operations.push("get:m-sent");
        return okJson({
          id: "m-sent",
          threadId: "t-2",
          labelIds: ["SENT", "UNREAD"],
          internalDate: "1770000001000",
          payload: {
            headers: [
              { name: "From", value: mailbox },
              { name: "To", value: "jane@example.com" },
              { name: "Subject", value: "Re: order" },
            ],
            body: { data: b64url("Already sent") },
          },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await backfillUnreadGmailInbox({
      tenantId,
      mailbox,
      layer,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      publish: async (event) => {
        operations.push(`publish:${event.payload.messageId}`);
        published.push(event);
      },
    });

    expect(result).toEqual({
      listed: 2,
      published: 1,
      skippedSent: 1,
      failed: 0,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "message.received",
      tenantId,
      threadId: "t-1",
      payload: {
        messageId: "m-unread",
        subject: "Still waiting on order #1001",
        bodyText: "Can someone help with this?",
      },
    });
    expect(operations).toEqual([
      "list",
      "get:m-unread",
      "publish:m-unread",
      "mark-read:m-unread",
      "get:m-sent",
    ]);
  });
});
