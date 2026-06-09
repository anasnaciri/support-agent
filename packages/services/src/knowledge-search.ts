// Pure, I/O-free ranker for the `knowledge.search` tool. Given a natural-
// language query and the tenant's knowledge documents, it returns the best few
// docs (title-weighted token overlap) with each doc's text capped to a token
// budget. No Effect, no DB — so it's trivially unit-testable and the tool just
// wraps a `listFull` read around it.
//
// v1 retrieval is deliberately simple (in-memory token overlap over a handful
// of docs, Postgres-native upstream — no embeddings / FTS infra), consistent
// with the ILIKE-not-Elasticsearch decision elsewhere in the repo. If a tenant
// ever accumulates many large docs this is the seam to swap for a real index.

// Common words carry no retrieval signal; dropping them keeps a natural-
// language question (\"how long is the return window?\") matching on the words
// that matter (\"return\", \"window\"). Intentionally small — over-aggressive
// stopwords would strip meaning, and fallback-to-all covers a missed match.
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "is",
  "are", "was", "were", "be", "been", "it", "this", "that", "these", "those",
  "as", "if", "but", "with", "your", "you", "my", "i", "we", "do", "does",
  "did", "will", "would", "can", "could", "should", "how", "what", "when",
  "where", "why", "who", "which", "about", "into", "from",
]);

/**
 * Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens.
 * Exported for its own unit test.
 */
export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );

export interface RankInputDoc {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface RankedDoc {
  readonly id: string;
  readonly title: string;
  /** `content`, capped to `perDocCharCap` (with an ellipsis when truncated). */
  readonly snippet: string;
  readonly score: number;
}

export interface RankOptions {
  /** Max docs returned (default 3). */
  readonly topK?: number;
  /** Max chars of each doc's text returned (default 8000 — fits a typical policy whole). */
  readonly perDocCharCap?: number;
}

/**
 * Rank `docs` against `query`. Score = (distinct query tokens in the title) × 2
 * + (distinct query tokens in the body) — a title hit weighs more than a body
 * mention. Returns the top-K by score; **falls back to the first top-K docs**
 * (score 0) when nothing matches, so the agent always gets something to read
 * rather than an empty result for a vague query.
 */
export const rankKnowledge = (
  query: string,
  docs: ReadonlyArray<RankInputDoc>,
  opts: RankOptions = {},
): ReadonlyArray<RankedDoc> => {
  const topK = opts.topK ?? 3;
  const cap = opts.perDocCharCap ?? 8000;
  const qTokens = new Set(tokenize(query));

  const scored = docs.map((d, i) => {
    const titleSet = new Set(tokenize(d.title));
    const bodySet = new Set(tokenize(d.content));
    let titleHits = 0;
    let bodyHits = 0;
    for (const t of qTokens) {
      if (titleSet.has(t)) titleHits++;
      if (bodySet.has(t)) bodyHits++;
    }
    return { d, i, score: titleHits * 2 + bodyHits };
  });

  const hits = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = (hits.length > 0 ? hits : scored).slice(0, topK);

  return chosen.map(({ d, score }) => ({
    id: d.id,
    title: d.title,
    score,
    snippet: d.content.length > cap ? `${d.content.slice(0, cap)}…` : d.content,
  }));
};
