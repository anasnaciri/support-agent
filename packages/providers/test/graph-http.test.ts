import { describe, expect, it, vi } from "vitest";
import {
  GraphHttpError,
  graphGetConversation,
  graphSendDraft,
  type GraphHttpFailure,
} from "../src/graph-http.js";

const okJson = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  }) as unknown as Response;

const fail = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "boom",
    headers: new Headers(headers),
  }) as unknown as Response;

const empty202 = (): Response =>
  ({
    ok: true,
    status: 202,
    json: async () => ({}),
    text: async () => "",
    headers: new Headers(),
  }) as unknown as Response;

const mailbox = "support@merchant.com";

describe("graphGetConversation", () => {
  it("escapes single quotes in the conversationId filter and sorts oldest → newest", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("conversationId%20eq%20'o''brien'");
      return okJson({
        value: [
          {
            id: "m-2",
            subject: "Re: hi",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-02T00:00:00Z",
            body: { contentType: "text", content: "later" },
          },
          {
            id: "m-1",
            subject: "hi",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-01T00:00:00Z",
            body: { contentType: "text", content: "first" },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const thread = await graphGetConversation({
      token: "t",
      conversationId: "o'brien",
      mailbox,
      fetchImpl,
    });
    expect(thread.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(thread.subject).toBe("hi");
  });

  it("strips HTML tags into bodyText when content is HTML", async () => {
    const fetchImpl = vi.fn(async () =>
      okJson({
        value: [
          {
            id: "m-1",
            from: { emailAddress: { address: "jane@example.com" } },
            sentDateTime: "2026-06-01T00:00:00Z",
            body: { contentType: "html", content: "<p>Hello <b>there</b></p>" },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const thread = await graphGetConversation({
      token: "t",
      conversationId: "c",
      mailbox,
      fetchImpl,
    });
    expect(thread.messages[0]!.bodyText).toBe("Hello  there");
    expect(thread.messages[0]!.bodyHtml).toBe("<p>Hello <b>there</b></p>");
  });

  const cases: ReadonlyArray<{ status: number; kind: GraphHttpFailure["kind"] }> = [
    { status: 401, kind: "auth_failed" },
    { status: 403, kind: "auth_failed" },
    { status: 404, kind: "not_found" },
    { status: 500, kind: "network" },
  ];
  for (const c of cases) {
    it(`maps HTTP ${c.status} → ${c.kind}`, async () => {
      const fetchImpl = vi.fn(async () => fail(c.status)) as unknown as typeof fetch;
      await expect(
        graphGetConversation({ token: "t", conversationId: "c", mailbox, fetchImpl }),
      ).rejects.toMatchObject({ failure: { kind: c.kind } });
    });
  }

  it("maps 429 → rate_limited with retryAfterMs from the retry-after header", async () => {
    const fetchImpl = vi.fn(async () =>
      fail(429, { "retry-after": "3" }),
    ) as unknown as typeof fetch;
    try {
      await graphGetConversation({ token: "t", conversationId: "c", mailbox, fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphHttpError);
      expect((err as GraphHttpError).failure).toEqual({
        kind: "rate_limited",
        retryAfterMs: 3000,
      });
    }
  });
});

describe("graphSendDraft", () => {
  it("resolves on a 202 with no body", async () => {
    const fetchImpl = vi.fn(async () => empty202()) as unknown as typeof fetch;
    await expect(
      graphSendDraft({ token: "t", draftId: "d", fetchImpl }),
    ).resolves.toBeUndefined();
  });
});
