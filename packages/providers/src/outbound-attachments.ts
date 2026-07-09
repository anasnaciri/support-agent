import { Effect } from "effect";
import {
  ConversationSendFailed,
  type MessageAttachment,
} from "@support-agent/agent-core";
import type { BlobStorage } from "@support-agent/services";

/**
 * A draft attachment with its bytes resolved — what a connector's outbound
 * encoder (Gmail MIME, Graph fileAttachment, SMTP sendMail) consumes.
 */
export interface OutboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Resolve a draft's `MessageAttachment[]` (storage keys) to bytes via
 * `BlobStorage`. A missing or unreadable blob FAILS the send rather than
 * silently dropping the file — the drafted body typically references the
 * attachment ("see attached"), and `ConversationSendFailed` keeps the send
 * retriable through the reply-delivery machinery.
 */
export const resolveOutboundAttachments = (
  blob: typeof BlobStorage.Service,
  attachments: ReadonlyArray<MessageAttachment>,
  draftId: string,
): Effect.Effect<ReadonlyArray<OutboundAttachment>, ConversationSendFailed> =>
  Effect.forEach(attachments, (attachment) =>
    blob.get(attachment.storageKey).pipe(
      Effect.map(
        (result): OutboundAttachment => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          bytes: result.bytes,
        }),
      ),
      Effect.mapError(
        () =>
          new ConversationSendFailed({
            draftId,
            reason: `attachment blob unavailable: ${attachment.filename}`,
          }),
      ),
    ),
  );

/**
 * RFC 2045 base64 body: 76-char lines joined with CRLF. Shared by the
 * hand-rolled MIME builders (Gmail send, IMAP Sent-copy append).
 */
export const encodeBase64Lines = (bytes: Uint8Array): string => {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines: Array<string> = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
};

/**
 * Filenames land inside quoted MIME header parameters; strip quotes and
 * CR/LF so a hostile filename can't break out of the header.
 */
export const sanitizeMimeFilename = (filename: string): string =>
  filename.replace(/["\r\n\\]/g, "_").trim() || "attachment";
