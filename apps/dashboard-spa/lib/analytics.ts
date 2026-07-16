export interface AnalyticsPeriodInput {
  readonly start: string;
  readonly end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const analyticsPeriod = (
  now: Date,
  trailingDays: number,
): AnalyticsPeriodInput => ({
  start: new Date(now.getTime() - trailingDays * DAY_MS).toISOString(),
  end: now.toISOString(),
});

export const formatAnalyticsDuration = (minutes: number | null): string => {
  if (minutes === null) return "No data";

  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;

  const hours = Math.floor(rounded / 60);
  if (hours < 24) {
    const remainder = rounded % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }

  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
};

export const formatAnalyticsPercentage = (percentage: number): string =>
  `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(percentage)}%`;

export const formatAnalyticsLabel = (value: string): string => {
  const words = value.replace(/[._-]+/g, " ").trim();
  return words.length === 0
    ? "Unknown"
    : words.charAt(0).toUpperCase() + words.slice(1);
};

export const formatMinorCurrency = (
  currencyCode: string,
  amountMinorUnits: number,
): string => {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
};

export const formatTransitDays = (days: number | null): string =>
  days === null
    ? "No data"
    : `${new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 1,
      }).format(days)}d`;
