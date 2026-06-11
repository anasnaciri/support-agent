import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  conversationUnavailableReason,
  projectConversationThread,
  resolveCaseConversationMailbox,
  resolveCaseConversationThread,
  sanitizeEmailHtml,
  stripQuotedText,
} from "../src/dashboard-conversation-thread.js";
import {
  ConversationAuthFailed,
  ConversationAuthMissing,
  ConversationProviderUnavailable,
  TenantId,
  ThreadId,
  ThreadNotFound,
  type ConversationThread,
} from "@support-agent/agent-core";

const tenantId = TenantId("tenant-1");
const threadId = ThreadId("gmail:thread-1");

describe("dashboard conversation thread", () => {
  it("projects a provider-neutral thread into a dashboard-safe JSON shape", () => {
    const thread: ConversationThread = {
      id: threadId,
      subject: "Return request",
      participants: [
        { name: "Customer", email: "customer@example.com" },
        { name: null, email: "support@example.com" },
      ],
      messages: [
        {
          id: "message-1",
          threadId,
          direction: "inbound",
          from: { name: "Customer", email: "customer@example.com" },
          to: [{ name: null, email: "support@example.com" }],
          subject: "Return request",
          bodyText: "Please help",
          bodyHtml: "<p>Please <strong>help</strong></p>",
          sentAt: new Date("2026-06-11T10:30:00.000Z"),
          attachments: [
            {
              filename: "photo.jpg",
              contentType: "image/jpeg",
              storageKey: "secret/tenant/message/photo.jpg",
              sizeBytes: 2048,
              exif: {
                hasExif: true,
                cameraMake: "Phone",
                cameraModel: "Model",
                dateTimeOriginal: null,
                gps: null,
              },
              phash: "123",
            },
          ],
        },
      ],
    };

    expect(projectConversationThread(thread)).toEqual({
      subject: "Return request",
      participants: [
        { name: "Customer", email: "customer@example.com" },
        { name: null, email: "support@example.com" },
      ],
      messages: [
        {
          id: "message-1",
          direction: "inbound",
          from: { name: "Customer", email: "customer@example.com" },
          to: [{ name: null, email: "support@example.com" }],
          subject: "Return request",
          bodyText: "Please help",
          sanitizedBodyHtml: "<p>Please <strong>help</strong></p>",
          sentAt: "2026-06-11T10:30:00.000Z",
          attachments: [
            {
              filename: "photo.jpg",
              contentType: "image/jpeg",
              sizeBytes: 2048,
            },
          ],
        },
      ],
    });
  });

  it("strips active content, remote resources, styles, and unsafe links", () => {
    const html = [
      '<div style="color:red" onclick="steal()">Hello</div>',
      "<script>alert(1)</script>",
      '<img src="https://tracker.example/pixel">',
      '<a href="javascript:alert(1)">bad</a>',
      '<a href="https://example.com/help" target="_blank">safe</a>',
      "<table><tr><td>kept</td></tr></table>",
    ].join("");

    const out = sanitizeEmailHtml(html);
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("img");
    expect(out).not.toContain("style");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('<a href="https://example.com/help">safe</a>');
    expect(out).toContain("<table><tr><td>kept</td></tr></table>");
  });

  it("removes quoted reply history from HTML and plain text", () => {
    expect(
      sanitizeEmailHtml(
        '<p>Latest reply</p><div class="gmail_quote"><p>Earlier message</p></div>',
      ),
    ).toBe("<p>Latest reply</p>");
    expect(
      stripQuotedText(
        "Latest reply\n\nOn Wed, Jun 10, 2026 at 12:00 PM Customer wrote:\n> Earlier message",
      ),
    ).toBe("Latest reply");
    expect(
      stripQuotedText(
        "Latest reply\n\n-----Original Message-----\nFrom: Customer\nEarlier message",
      ),
    ).toBe("Latest reply");
  });

  it("deduplicates repeated provider message ids before display", () => {
    const message: ConversationThread["messages"][number] = {
      id: "message-1",
      threadId,
      direction: "inbound",
      from: { name: "Customer", email: "customer@example.com" },
      to: [{ name: null, email: "support@example.com" }],
      subject: "Return request",
      bodyText: "Latest reply\n\n> Earlier message",
      bodyHtml: null,
      sentAt: new Date("2026-06-11T10:30:00.000Z"),
      attachments: [],
    };
    const projected = projectConversationThread({
      id: threadId,
      subject: "Return request",
      participants: [],
      messages: [message, { ...message }],
    });
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]?.bodyText).toBe("Latest reply");
  });

  it("maps connector failures to stable dashboard reasons", () => {
    expect(
      conversationUnavailableReason(new ThreadNotFound({ tenantId, threadId })),
    ).toBe("thread_not_found");
    expect(
      conversationUnavailableReason(
        new ConversationAuthMissing({ tenantId, provider: "gmail" }),
      ),
    ).toBe("auth_required");
    expect(
      conversationUnavailableReason(
        new ConversationAuthFailed({ tenantId, provider: "gmail" }),
      ),
    ).toBe("auth_required");
    expect(
      conversationUnavailableReason(
        new ConversationProviderUnavailable({ provider: "gmail" }),
      ),
    ).toBe("provider_unavailable");
  });

  it("fails closed when an old case is ambiguous across active mailboxes", () => {
    const connections = [
      {
        tenantId,
        provider: "gmail" as const,
        shopDomain: "first@merchant.com",
        accessToken: "secret",
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: {},
        scopes: [],
        apiVersion: null,
        installedAt: new Date(),
        status: "active" as const,
      },
      {
        tenantId,
        provider: "gmail" as const,
        shopDomain: "second@merchant.com",
        accessToken: "secret",
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: {},
        scopes: [],
        apiVersion: null,
        installedAt: new Date(),
        status: "active" as const,
      },
    ];
    expect(resolveCaseConversationMailbox(null, "gmail", connections)).toEqual({
      ok: false,
      reason: "mailbox_ambiguous",
    });
    expect(
      resolveCaseConversationMailbox(
        "first@merchant.com",
        "gmail",
        connections,
      ),
    ).toEqual({ ok: true, mailbox: "first@merchant.com" });
  });

  it("loads a legacy case by probing connected mailboxes until one matches", async () => {
    const connections = [
      {
        tenantId,
        provider: "gmail" as const,
        shopDomain: "first@merchant.com",
        accessToken: "secret",
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: {},
        scopes: [],
        apiVersion: null,
        installedAt: new Date(),
        status: "active" as const,
      },
      {
        tenantId,
        provider: "gmail" as const,
        shopDomain: "second@merchant.com",
        accessToken: "secret",
        refreshToken: null,
        tokenExpiresAt: null,
        metadata: {},
        scopes: [],
        apiVersion: null,
        installedAt: new Date(),
        status: "active" as const,
      },
    ];
    const thread = await Effect.runPromise(
      resolveCaseConversationThread(
        null,
        null,
        connections,
        (provider, mailbox) =>
          provider === "gmail" && mailbox === "first@merchant.com"
            ? Effect.fail(new ThreadNotFound({ tenantId, threadId }))
            : Effect.succeed({
                id: threadId,
                subject: "Return request",
                participants: [
                  { name: "Customer", email: "customer@example.com" },
                  { name: null, email: mailbox },
                ],
                messages: [
                  {
                    id: "message-1",
                    threadId,
                    direction: "inbound",
                    from: { name: "Customer", email: "customer@example.com" },
                    to: [{ name: null, email: mailbox }],
                    subject: "Return request",
                    bodyText: "Please help",
                    bodyHtml: null,
                    sentAt: new Date("2026-06-11T10:30:00.000Z"),
                    attachments: [],
                  },
                ],
              }),
      ),
    );

    expect(thread).toEqual({
      ok: true,
      mailbox: "second@merchant.com",
      thread: expect.objectContaining({
        id: threadId,
      }),
    });
  });
});
