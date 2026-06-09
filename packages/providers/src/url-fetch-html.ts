// Minimal, dependency-free HTML → readable-text extraction for fetched
// knowledge documents. Not a full parser — just enough to turn a policy page
// into the plain text the agents read. Pure + unit-tested.

const safeCodePoint = (n: number): string => {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&(?:apos|#0*39);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");

const collapse = (s: string): string =>
  s
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Extract and decode the document `<title>`, or null when absent. */
export const extractTitle = (html: string): string | null => {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = m?.[1]?.trim();
  return raw ? decodeEntities(raw) : null;
};

/** Strip markup to readable text: drop non-content elements, keep block breaks. */
export const htmlToText = (html: string): string => {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Drop elements whose text content is never reader-facing.
    .replace(
      /<(script|style|head|nav|footer|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    // Block-level closers / line breaks become newlines so paragraphs survive.
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Everything else: drop the tag.
    .replace(/<[^>]+>/g, " ");
  return collapse(decodeEntities(stripped));
};
