// How a thread attachment is offered to the manager. Pure so the security
// call (never inline an SVG; never link an attachment we hold no bytes for)
// is pinned by tests rather than buried in JSX.

/** Image types we are willing to render in an <img> on our own origin. */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type AttachmentPreviewKind =
  /** Render a thumbnail; clicking opens the lightbox. */
  | "image"
  /** Offer a download through a short-lived signed URL. */
  | "file"
  /** Metadata-only badge: no indexed bytes, so nothing to fetch. */
  | "inert";

/**
 * `id` is the `ticket_attachments` row id, present only for files whose bytes
 * we actually stored. SVG is deliberately NOT inlined even though it is an
 * `image/*` type: it can carry script, and it is off the upload allowlist
 * anyway — an SVG here could only have come from a connector.
 */
export const attachmentPreviewKind = (attachment: {
  readonly id: string | null;
  readonly contentType: string;
}): AttachmentPreviewKind => {
  if (!attachment.id) return "inert";
  const type = attachment.contentType.split(";")[0]!.trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(type) ? "image" : "file";
};
