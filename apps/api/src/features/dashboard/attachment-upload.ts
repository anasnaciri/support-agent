import type { TicketAttachmentRecord } from "@support-agent/services";
import type { TicketAttachmentSummary } from "@support-agent/dashboard-contracts";

/**
 * Upload validation shared by the merchant (dashboard) and supplier (portal)
 * attachment endpoints. Uploads are raw bytes with the file's content type on
 * the request; this module owns the allowlist, the size cap, and a magic-byte
 * sniff so a declared type can't lie about the payload that will later be
 * MIME-encoded into a customer-facing email.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // matches ingestion cap

const MAGIC: ReadonlyArray<{
  readonly contentType: string;
  readonly ext: string;
  readonly matches: (b: Buffer) => boolean;
}> = [
  {
    contentType: "image/jpeg",
    ext: "jpg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: "image/png",
    ext: "png",
    matches: (b) =>
      b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  },
  {
    contentType: "image/gif",
    ext: "gif",
    matches: (b) => b.length > 6 && b.subarray(0, 3).toString("latin1") === "GIF",
  },
  {
    contentType: "image/webp",
    ext: "webp",
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    contentType: "application/pdf",
    ext: "pdf",
    matches: (b) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
  },
];

export const ALLOWED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set(
  MAGIC.map((m) => m.contentType),
);

export type AttachmentUploadValidation =
  | {
      readonly ok: true;
      readonly filename: string;
      readonly contentType: string;
      readonly ext: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | "unsupported_type"
        | "empty_body"
        | "too_large"
        | "content_mismatch"
        | "missing_filename";
    };

/**
 * Validate a raw upload. `contentType` is the declared type (request
 * Content-Type header, parameters stripped); bytes must match its magic
 * signature. The returned filename is trimmed and length-capped, never empty.
 */
export const validateAttachmentUpload = (input: {
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
  readonly bytes: Buffer;
}): AttachmentUploadValidation => {
  const declared = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const spec = MAGIC.find((m) => m.contentType === declared);
  if (!spec) return { ok: false, error: "unsupported_type" };
  if (input.bytes.length === 0) return { ok: false, error: "empty_body" };
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "too_large" };
  }
  if (!spec.matches(input.bytes)) return { ok: false, error: "content_mismatch" };
  const filename = (input.filename ?? "").trim().slice(0, 200);
  if (!filename) return { ok: false, error: "missing_filename" };
  return { ok: true, filename, contentType: declared, ext: spec.ext };
};

/** Storage key for an uploaded attachment blob. */
export const uploadStorageKey = (
  tenantId: string,
  ticketId: string,
  uploadId: string,
  ext: string,
): string => `upload/${tenantId}/${ticketId}/${uploadId}.${ext}`;

export const toAttachmentSummary = (
  record: TicketAttachmentRecord,
): TicketAttachmentSummary => ({
  id: record.id,
  filename: record.filename,
  contentType: record.contentType,
  sizeBytes: record.sizeBytes,
  source: record.source,
  createdAt: record.createdAt.toISOString(),
});
