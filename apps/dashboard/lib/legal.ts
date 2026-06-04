const trimSlash = (s: string): string => s.replace(/\/+$/, "");

export const dataProcessingNoticeUrl = (): string | null => {
  const raw = process.env["DASHBOARD_API_BASE_URL"];
  if (!raw || raw.trim().length === 0) return null;
  try {
    return `${trimSlash(new URL(raw.trim()).origin)}/legal/data-processing`;
  } catch {
    return null;
  }
};
