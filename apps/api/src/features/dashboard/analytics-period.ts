const MAX_ANALYTICS_RANGE_MS = 365 * 86_400_000;
const DEFAULT_ANALYTICS_RANGE_MS = 30 * 86_400_000;

export type AnalyticsPeriodResult =
  | { readonly ok: true; readonly start: Date; readonly end: Date }
  | {
      readonly ok: false;
      readonly error:
        | "invalid_analytics_period"
        | "analytics_period_too_large";
    };

export const parseAnalyticsPeriod = (
  query: Record<string, unknown>,
  now: Date = new Date(),
): AnalyticsPeriodResult => {
  const parse = (value: unknown): Date | null => {
    if (typeof value !== "string" || value.length === 0) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const rawStart = query["start"];
  const rawEnd = query["end"];
  const end = rawEnd === undefined ? now : parse(rawEnd);
  const start =
    rawStart === undefined
      ? new Date((end ?? now).getTime() - DEFAULT_ANALYTICS_RANGE_MS)
      : parse(rawStart);
  if (!start || !end || start >= end) {
    return { ok: false, error: "invalid_analytics_period" };
  }
  if (end.getTime() - start.getTime() > MAX_ANALYTICS_RANGE_MS) {
    return { ok: false, error: "analytics_period_too_large" };
  }
  return { ok: true, start, end };
};
