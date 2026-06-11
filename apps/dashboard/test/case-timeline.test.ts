import { describe, expect, it } from "vitest";
import {
  buildCaseTimelineHref,
  conversationThreadUnavailableView,
  formatAttachmentSize,
  parseCaseTimelineMode,
} from "../app/cases/[id]/case-timeline.js";

describe("case timeline navigation", () => {
  it("accepts all three modes and defaults unknown values to full", () => {
    expect(parseCaseTimelineMode(undefined)).toBe("full");
    expect(parseCaseTimelineMode("full")).toBe("full");
    expect(parseCaseTimelineMode("simplified")).toBe("simplified");
    expect(parseCaseTimelineMode("email")).toBe("email");
    expect(parseCaseTimelineMode("other")).toBe("full");
  });

  it("preserves other query parameters while switching modes", () => {
    const params = { takenOver: "yes", timeline: "simplified" };
    expect(buildCaseTimelineHref("case-1", params, "email")).toBe(
      "/cases/case-1?takenOver=yes&timeline=email",
    );
    expect(buildCaseTimelineHref("case-1", params, "full")).toBe(
      "/cases/case-1?takenOver=yes",
    );
  });

  it("formats attachment sizes for display", () => {
    expect(formatAttachmentSize(500)).toBe("500 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("marks only mailbox-auth failures as reconnectable", () => {
    expect(conversationThreadUnavailableView("auth_required")).toMatchObject({
      title: "Reconnect the mailbox",
      showIntegrationsLink: true,
    });
    expect(
      conversationThreadUnavailableView("provider_unavailable"),
    ).toMatchObject({
      title: "Email provider temporarily unavailable",
      showIntegrationsLink: false,
    });
  });
});
