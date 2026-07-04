import { Effect } from "effect";
import type {
  MessageAttachment,
  TenantId,
} from "@support-agent/agent-core";
import type { BlobStorage } from "@support-agent/services";
import {
  GmailHttpError,
  gmailGetAttachment,
  type GmailImageAttachmentMetadata,
} from "./gmail-http.js";
import { extractImageExif, type ExifParse } from "./image-exif.js";
import { computeImagePHash } from "./image-phash.js";

// ============================================================
// Limits — per-message
// ============================================================
//
// Caps prevent a single inbound message from monopolizing a tenant's
// blob budget OR triggering a 100k-context LLM rate-limit. Conservative
// defaults; revisit when a damaged-product agent gets enough live
// traffic that the limits start biting.

const MAX_IMAGES_PER_MESSAGE = 8;
const MAX_BYTES_PER_ATTACHMENT = 10 * 1024 * 1024; // 10 MiB
const MAX_BYTES_PER_MESSAGE = 25 * 1024 * 1024; // 25 MiB

// ============================================================
// Storage key composition
// ============================================================

const extensionFor = (mimeType: string): string => {
  // Cheap mapping for the common image MIMEs Gmail surfaces. Unknown
  // types get `.bin` rather than guessing — LLM providers ignore the
  // extension and read `mediaType` from the request anyway.
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
};

export const buildGmailAttachmentStorageKey = (
  tenantId: TenantId,
  messageId: string,
  attachmentId: string,
  mimeType: string,
): string =>
  `gmail/${tenantId}/${messageId}/${attachmentId}.${extensionFor(mimeType)}`;

// ============================================================
// Main entry point
// ============================================================

export interface ProcessGmailImageAttachmentsInput {
  readonly tenantId: TenantId;
  readonly messageId: string;
  readonly token: string;
  readonly imageAttachments: ReadonlyArray<GmailImageAttachmentMetadata>;
  readonly blob: typeof BlobStorage.Service;
  readonly fetchImpl?: typeof fetch;
  // Injectable EXIF parser (defaults to the real `exifr`-backed one). The
  // webhook never passes this; tests do, to assert metadata stamping
  // without real image bytes.
  readonly exifParser?: ExifParse;
  // Injectable perceptual-hash function (defaults to the real `jimp`-backed
  // one). Same testability rationale as `exifParser`.
  readonly phasher?: (bytes: Uint8Array) => Promise<bigint | null>;
}

/**
 * For each image attachment in a Gmail message: fetch its bytes via
 * `gmailGetAttachment`, upload to `BlobStorage`, and produce a
 * `MessageAttachment` carrying the resulting `storageKey`. The result
 * is what the webhook handler stamps onto the `InboundMessage` it
 * publishes — that's how the agent runtime sees images on the message.
 *
 * Failure handling is per-attachment: if any single upload fails (Gmail
 * 404 on the attachment, BlobStorage transient error, etc.) we log and
 * skip it but keep going. The message still publishes, just without
 * that one image. Losing every attachment is the worst case — the
 * agent gets the body text and can decline / escalate.
 *
 * Caps: at most `MAX_IMAGES_PER_MESSAGE` images; each at most
 * `MAX_BYTES_PER_ATTACHMENT`; cumulative ≤ `MAX_BYTES_PER_MESSAGE`.
 * Caps are intentionally checked against the reported size BEFORE the
 * fetch when possible so we don't pull bytes we'd just discard.
 */
export const processGmailImageAttachments = async (
  input: ProcessGmailImageAttachmentsInput,
): Promise<ReadonlyArray<MessageAttachment>> => {
  const out: Array<MessageAttachment> = [];
  let cumulativeBytes = 0;
  const slice = input.imageAttachments.slice(0, MAX_IMAGES_PER_MESSAGE);

  for (const meta of slice) {
    if (meta.sizeBytes > MAX_BYTES_PER_ATTACHMENT) {
      // eslint-disable-next-line no-console
      console.warn(
        `[gmail attachments] skipping ${meta.filename}: ${meta.sizeBytes} bytes exceeds per-attachment cap`,
      );
      continue;
    }
    if (cumulativeBytes + meta.sizeBytes > MAX_BYTES_PER_MESSAGE) {
      // eslint-disable-next-line no-console
      console.warn(
        `[gmail attachments] skipping ${meta.filename}: cumulative cap would be exceeded`,
      );
      continue;
    }
    try {
      const fetched = await gmailGetAttachment({
        token: input.token,
        messageId: input.messageId,
        attachmentId: meta.attachmentId,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      // Honour the per-attachment cap against the actual bytes too, in
      // ticket Gmail's `size` was wildly under-reported. Defensive — the
      // server side is the only honest source.
      if (fetched.bytes.byteLength > MAX_BYTES_PER_ATTACHMENT) {
        // eslint-disable-next-line no-console
        console.warn(
          `[gmail attachments] skipping ${meta.filename}: post-fetch size ${fetched.bytes.byteLength} bytes exceeds cap`,
        );
        continue;
      }
      const storageKey = buildGmailAttachmentStorageKey(
        input.tenantId,
        input.messageId,
        meta.attachmentId,
        meta.mimeType,
      );
      const putExit = await Effect.runPromiseExit(
        input.blob.put({
          tenantId: input.tenantId,
          key: storageKey,
          bytes: fetched.bytes,
          contentType: meta.mimeType,
        }),
      );
      if (putExit._tag !== "Success") {
        // eslint-disable-next-line no-console
        console.error(
          `[gmail attachments] BlobStorage.put failed for ${meta.filename}:`,
          putExit.cause,
        );
        continue;
      }
      cumulativeBytes += fetched.bytes.byteLength;
      // EXIF inspection is a no-cost fraud signal for the damaged-product
      // flow. `extractImageExif` never throws, so a parse failure just
      // yields `hasExif: false` rather than dropping the attachment.
      const exif = await extractImageExif(fetched.bytes, input.exifParser);
      // Perceptual hash for duplicate-photo detection. Also never throws;
      // null (undecodable) just means no `phash` on the attachment.
      const phashValue = await (input.phasher ?? computeImagePHash)(
        fetched.bytes,
      );
      out.push({
        filename: meta.filename,
        contentType: meta.mimeType,
        storageKey,
        sizeBytes: fetched.bytes.byteLength,
        exif,
        ...(phashValue !== null ? { phash: phashValue.toString() } : {}),
      });
    } catch (cause) {
      // GmailHttpError + unknown errors both go here. Log + skip — the
      // message body still gets published.
      const msg =
        cause instanceof GmailHttpError
          ? `${cause.failure.kind}`
          : String(cause);
      // eslint-disable-next-line no-console
      console.warn(
        `[gmail attachments] fetch failed for ${meta.filename} (${meta.attachmentId}): ${msg}`,
      );
    }
  }

  return out;
};
