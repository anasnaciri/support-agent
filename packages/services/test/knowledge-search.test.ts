import { describe, expect, it } from "vitest";
import { rankKnowledge, tokenize } from "../src/knowledge-search.js";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords + 1-char tokens", () => {
    expect(tokenize("What is the Return Window?")).toEqual([
      "return",
      "window",
    ]);
  });

  it("keeps digits and multi-char tokens, drops punctuation noise", () => {
    expect(tokenize("Refund within 30 days — no fee!")).toEqual([
      "refund",
      "within",
      "30",
      "days",
      "no",
      "fee",
    ]);
  });

  it("returns an empty array for all-stopword / empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("the a of to and")).toEqual([]);
  });
});

describe("rankKnowledge", () => {
  const docs = [
    { id: "ship", title: "Shipping policy", content: "We ship within 3 days." },
    {
      id: "ret",
      title: "Returns policy",
      content: "Returns accepted within 30 days of delivery for a full refund.",
    },
    {
      id: "noise",
      title: "About us",
      content: "shipping is mentioned here once incidentally.",
    },
  ];

  it("returns an empty array when there are no documents", () => {
    expect(rankKnowledge("anything", [])).toEqual([]);
  });

  it("weights a title match above a body-only match", () => {
    const ranked = rankKnowledge("shipping", docs);
    // "Shipping policy" (title hit, score 2) must outrank "About us" whose
    // body merely mentions shipping (body hit, score 1).
    expect(ranked[0]?.id).toBe("ship");
    expect(ranked[0]!.score).toBeGreaterThan(
      ranked.find((r) => r.id === "noise")!.score,
    );
  });

  it("matches a natural-language query against title + body tokens", () => {
    const ranked = rankKnowledge("how long is the return window for a refund", docs);
    expect(ranked[0]?.id).toBe("ret");
  });

  it("caps the result set at topK", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      title: `Policy ${i}`,
      content: "refund refund refund",
    }));
    expect(rankKnowledge("refund", many, { topK: 2 })).toHaveLength(2);
  });

  it("caps each snippet at perDocCharCap and appends an ellipsis", () => {
    const long = [
      { id: "x", title: "X", content: "a".repeat(100) },
    ];
    const [r] = rankKnowledge("x", long, { perDocCharCap: 10 });
    expect(r!.snippet).toHaveLength(11); // 10 chars + the ellipsis
    expect(r!.snippet.endsWith("…")).toBe(true);
  });

  it("does NOT truncate content shorter than the cap", () => {
    const [r] = rankKnowledge("shipping", docs, { perDocCharCap: 8000 });
    expect(r!.snippet).toBe("We ship within 3 days.");
    expect(r!.snippet.endsWith("…")).toBe(false);
  });

  it("falls back to the first topK docs when nothing matches the query", () => {
    const ranked = rankKnowledge("zzzzzzzz", docs, { topK: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.id)).toEqual(["ship", "ret"]);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("returns id, title, snippet and score on each result", () => {
    const [r] = rankKnowledge("returns", docs);
    expect(r).toMatchObject({
      id: "ret",
      title: "Returns policy",
    });
    expect(typeof r!.snippet).toBe("string");
    expect(typeof r!.score).toBe("number");
  });
});
