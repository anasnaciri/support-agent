import { describe, expect, it } from "vitest";
import {
  conversationUnavailableReason,
  projectConversationThread,
  sanitizeEmailHtml,
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
});
