const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * The public data-processing notice served by apps/api. Derived from the base
 * URL, keeping only the origin (the api registers /legal/data-processing at
 * the server root). Null when the base is unset or malformed.
 */
export const deriveDataProcessingNoticeUrl = (
  apiBaseUrl: string | undefined,
): string | null => {
  if (!apiBaseUrl || apiBaseUrl.trim().length === 0) return null;
  try {
    return `${trimSlash(new URL(apiBaseUrl.trim()).origin)}/legal/data-processing`;
  } catch {
    return null;
  }
};

// VITE_API_BASE_URL is the SPA's api origin (same var the api-client
// transport requires); the Next app's DASHBOARD_API_BASE_URL never exists in
// the browser bundle.
export const dataProcessingNoticeUrl = (): string | null =>
  deriveDataProcessingNoticeUrl(import.meta.env.VITE_API_BASE_URL);
