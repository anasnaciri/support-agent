export interface UsageAuditRow {
  readonly occurredAt: Date;
  readonly details: unknown;
}

export interface ModelPricing {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
}

export interface UsagePoint {
  readonly day: string;
  readonly model: string;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedUsd: number | null;
}

const detailRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const tokenNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

export const estimateUsageCostUsd = (
  usage: Pick<UsagePoint, "provider" | "model" | "inputTokens" | "outputTokens">,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): number | null => {
  const pricing = pricingByModel.get(usage.model);
  if (!pricing) return null;
  // Pre-provider historical rows usually came through OpenRouter but did not
  // stamp provider. Native direct-provider rows stay unpriced until direct
  // pricing tables land.
  if (usage.provider !== null && usage.provider !== "openrouter") return null;
  return (
    usage.inputTokens * pricing.inputUsdPerToken +
    usage.outputTokens * pricing.outputUsdPerToken
  );
};

export const aggregateUsageRows = (
  rows: ReadonlyArray<UsageAuditRow>,
  pricingByModel: ReadonlyMap<string, ModelPricing> = new Map(),
): ReadonlyArray<UsagePoint> => {
  const grouped = new Map<
    string,
    Pick<
      UsagePoint,
      "day" | "model" | "provider" | "inputTokens" | "outputTokens"
    >
  >();

  for (const row of rows) {
    const details = detailRecord(row.details);
    const usage = detailRecord(details?.["usage"]);
    if (!usage) continue;
    const model = usage["model"];
    if (typeof model !== "string" || !model) continue;
    const provider =
      typeof usage["provider"] === "string" ? (usage["provider"] as string) : null;
    const day = dayKey(row.occurredAt);
    const key = `${day}\x00${provider ?? ""}\x00${model}`;
    const prior = grouped.get(key);
    const inputTokens = tokenNumber(usage["inputTokens"]);
    const outputTokens = tokenNumber(usage["outputTokens"]);
    if (prior) {
      grouped.set(key, {
        ...prior,
        inputTokens: prior.inputTokens + inputTokens,
        outputTokens: prior.outputTokens + outputTokens,
      });
    } else {
      grouped.set(key, {
        day,
        model,
        provider,
        inputTokens,
        outputTokens,
      });
    }
  }

  return Array.from(grouped.values())
    .map((point) => {
      const totalTokens = point.inputTokens + point.outputTokens;
      return {
        ...point,
        totalTokens,
        estimatedUsd: estimateUsageCostUsd(
          point,
          pricingByModel,
        ),
      };
    })
    .sort((a, b) => {
      if (a.day !== b.day) return b.day.localeCompare(a.day);
      return a.model.localeCompare(b.model);
    });
};

export const sumUsagePoints = (
  points: ReadonlyArray<UsagePoint>,
): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedUsd: number | null;
  readonly unpricedRows: number;
} => {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  let sawPriced = false;
  let unpricedRows = 0;
  for (const p of points) {
    inputTokens += p.inputTokens;
    outputTokens += p.outputTokens;
    if (p.estimatedUsd === null) {
      unpricedRows += 1;
    } else {
      sawPriced = true;
      estimatedUsd += p.estimatedUsd;
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: sawPriced ? estimatedUsd : null,
    unpricedRows,
  };
};

export const monthBoundsUtc = (
  month: string | undefined,
  now: Date = new Date(),
): { readonly month: string; readonly start: Date; readonly end: Date } => {
  const normalized =
    month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : now.toISOString().slice(0, 7);
  const [yearRaw, monthRaw] = normalized.split("-");
  const year = Number.parseInt(yearRaw!, 10);
  const monthIndex = Number.parseInt(monthRaw!, 10) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  return { month: normalized, start, end };
};
