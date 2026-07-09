import { describe, expect, it } from "vitest";
import { decodeApprovedReply } from "../ticket-handlers.js";

// The stored input of a `conversation.reply` approval, re-read when a manager
// resends a reply that was approved but never sent (skipped on takeover).
const draft = (over: Record<string, unknown> = {}) => ({
  threadId: "gmail:t-1",
  to: [{ name: "Jane", email: "jane@example.com" }],
  subject: null,
  bodyText: "Here is the replacement label.",
  bodyHtml: null,
  inReplyToMessageId: "msg-0",
  draftId: "d-1",
  ...over,
});

describe("decodeApprovedReply", () => {
  it("decodes the reply fields", () => {
    expect(decodeApprovedReply(draft())).toMatchObject({
      threadId: "gmail:t-1",
      bodyText: "Here is the replacement label.",
      draftId: "d-1",
      inReplyToMessageId: "msg-0",
    });
  });

  // The whole point of the approved draft was to send the label. Dropping the
  // ids on resend delivers a reply that promises a file it doesn't carry.
  it("preserves the draft's attachmentIds", () => {
    const decoded = decodeApprovedReply(
      draft({ attachmentIds: ["att-1", "att-2"] }),
    );
    expect(decoded?.attachmentIds).toEqual(["att-1", "att-2"]);
  });

  it("defaults attachmentIds to empty when absent", () => {
    expect(decodeApprovedReply(draft())?.attachmentIds).toEqual([]);
  });

  it("ignores non-string ids rather than passing junk to the store", () => {
    const decoded = decodeApprovedReply(
      draft({ attachmentIds: ["att-1", 42, null, "att-2"] }),
    );
    expect(decoded?.attachmentIds).toEqual(["att-1", "att-2"]);
  });

  it("returns null for a draft with no recipients or no body", () => {
    expect(decodeApprovedReply(draft({ to: [] }))).toBeNull();
    expect(decodeApprovedReply(draft({ bodyText: undefined }))).toBeNull();
    expect(decodeApprovedReply(null)).toBeNull();
  });
});
