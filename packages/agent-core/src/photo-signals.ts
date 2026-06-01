import type { MessageAttachment } from "./payloads.js";

/**
 * Per-case rollup of the EXIF fraud signal across all image attachments on
 * an inbound message. The runtime stamps this onto `case.context` so the
 * dashboard ApprovalCard can surface an "EXIF: stripped" chip without
 * re-reading the blobs. `null` when the message had no image attachments.
 */
export interface PhotoSignals {
  /** Number of image attachments considered. */
  readonly count: number;
  /** How many carried recognisable camera metadata. */
  readonly withExif: number;
  /** How many had their camera metadata stripped (or never had any). */
  readonly stripped: number;
  /** True when at least one image was stripped — the headline signal. */
  readonly anyStripped: boolean;
}

export const summarizePhotoSignals = (
  attachments: ReadonlyArray<MessageAttachment>,
): PhotoSignals | null => {
  const images = attachments.filter((a) =>
    a.contentType.startsWith("image/"),
  );
  if (images.length === 0) return null;
  let withExif = 0;
  for (const img of images) {
    if (img.exif?.hasExif === true) withExif += 1;
  }
  const stripped = images.length - withExif;
  return {
    count: images.length,
    withExif,
    stripped,
    anyStripped: stripped > 0,
  };
};
