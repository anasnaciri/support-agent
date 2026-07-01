import { describe, expect, it } from "vitest";
import {
  aggregateUsageRows,
  monthBoundsUtc,
  sumUsagePoints,
} from "../lib/usage";

describe("usage aggregation", () => {
  it("groups audit-log LLM usage by UTC day, provider, and model", () => {
    const points = aggregateUsageRows([
      {
        occurredAt: new Date("2026-05-02T03:00:00.000Z"),
        details: {
          usage: {
            provider: "openrouter",
            model: "google/gemini-3.5-flash",
            inputTokens: 100,
            outputTokens: 25,
          },
        },
      },
      {
        occurredAt: new Date("2026-05-02T23:00:00.000Z"),
        details: {
          usage: {
            provider: "openrouter",
            model: "google/gemini-3.5-flash",
            inputTokens: 50,
            outputTokens: 10,
          },
        },
      },
      {
        occurredAt: new Date("2026-05-03T01:00:00.000Z"),
        details: {
          usage: {
            provider: "anthropic",
            model: "claude-haiku-4.5",
            inputTokens: 40,
            outputTokens: 20,
          },
        },
      },
    ]);

    expect(points).toHaveLength(2);
    expect(points.find((p) => p.day === "2026-05-02")).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      inputTokens: 150,
      outputTokens: 35,
      totalTokens: 185,
    });
  });

  it("estimates USD only when OpenRouter pricing exists", () => {
    const points = aggregateUsageRows(
      [
        {
          occurredAt: new Date("2026-05-02T03:00:00.000Z"),
          details: {
            usage: {
              provider: "openrouter",
              model: "google/gemini-3.5-flash",
              inputTokens: 100,
              outputTokens: 25,
            },
          },
        },
        {
          occurredAt: new Date("2026-05-02T04:00:00.000Z"),
          details: {
            usage: {
              provider: "anthropic",
              model: "claude-haiku-4.5",
              inputTokens: 100,
              outputTokens: 25,
            },
          },
        },
      ],
      new Map([
        [
          "google/gemini-3.5-flash",
          { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002 },
        ],
        [
          "claude-haiku-4.5",
          { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000002 },
        ],
      ]),
    );
    const openrouter = points.find((p) => p.provider === "openrouter");
    const direct = points.find((p) => p.provider === "anthropic");

    expect(openrouter?.estimatedUsd).toBeCloseTo(0.00015);
    expect(direct?.estimatedUsd).toBeNull();
    expect(sumUsagePoints(points)).toMatchObject({
      totalTokens: 250,
      estimatedUsd: 0.00015,
      unpricedRows: 1,
    });
  });

  it("parses month bounds in UTC and falls back to the current month", () => {
    expect(monthBoundsUtc("2026-05").start.toISOString()).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(monthBoundsUtc("2026-05").end.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(
      monthBoundsUtc("bad", new Date("2026-07-12T00:00:00.000Z")).month,
    ).toBe("2026-07");
  });
});
