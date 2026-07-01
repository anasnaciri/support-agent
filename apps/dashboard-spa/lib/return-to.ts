// Sanitises a `returnTo` value before it is used as a redirect target. The
// value rides in the URL across the sign-in/sign-up -> OAuth -> /callback
// round-trip, so it is attacker-influenceable: an unchecked redirect would
// be an open-redirect vector (`//evil.com`, `https://evil.com`, `\evil.com`).
//
// We accept ONLY a same-origin absolute path: one leading slash, no
// protocol-relative `//`, no backslash tricks browsers normalise to `//`, no
// scheme, and no control characters / whitespace (header-injection / CRLF).
// Anything else collapses to the caller's fallback (default "/").
export const sanitizeReturnTo = (
  value: string | null | undefined,
  fallback = "/",
): string => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  // Must be an absolute path, but not protocol-relative.
  if (value[0] !== "/" || value[1] === "/") return fallback;
  // Browsers treat backslashes as slashes; a leading "/\" becomes "//".
  if (value.includes("\\")) return fallback;
  // No embedded scheme (defence-in-depth alongside the leading-slash check).
  if (value.includes("://")) return fallback;
  // Reject control chars, space, and DEL (CRLF header injection / broken URL).
  if (/[\u0000-\u0020\u007f]/.test(value)) return fallback;
  return value;
};
