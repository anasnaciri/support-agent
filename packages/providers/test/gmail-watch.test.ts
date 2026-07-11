import { describe, expect, it, vi } from "vitest";
import { startGmailWatch } from "../src/gmail-watch.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

describe("startGmailWatch", () => {
  it("watches INBOX only, so spam-foldered mail is not ingested", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        topicName: string;
        labelIds: string[];
        labelFilterBehavior: string;
      };
      expect(body.topicName).toBe("projects/p/topics/t");
      expect(body.labelIds).toEqual(["INBOX"]);
      expect(body.labelFilterBehavior).toBe("INCLUDE");
      return okJson({ historyId: "100", expiration: "1780000000000" });
    });
    const result = await startGmailWatch({
      accessToken: "tok",
      topicName: "projects/p/topics/t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.historyId).toBe("100");
    expect(result.expiresAt).toEqual(new Date(1780000000000));
  });

  it("honours an explicit labelIds override", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { labelIds: string[] };
      expect(body.labelIds).toEqual(["INBOX", "SPAM"]);
      return okJson({ historyId: "101", expiration: "1780000000000" });
    });
    await startGmailWatch({
      accessToken: "tok",
      topicName: "projects/p/topics/t",
      labelIds: ["INBOX", "SPAM"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
