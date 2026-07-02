import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessedEventStore, ProcessedEventStoreTest } from "../src/index.js";

// H7 — event-level redelivery dedup. Mirrors the ProcessedMessageStore (C3)
// contract but keys on the pg-boss `eventId` so ANY re-delivered job (not just
// message.received) is skipped once its first run committed.

const run = <A>(program: Effect.Effect<A, unknown, ProcessedEventStore>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, ProcessedEventStoreTest) as Effect.Effect<A, never, never>,
  );

describe("ProcessedEventStore", () => {
  it("claims an id exactly once (new, then duplicate)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* ProcessedEventStore;
        const first = yield* store.claim("evt-1");
        const second = yield* store.claim("evt-1");
        return { first, second };
      }),
    );
    expect(out.first).toBe("new");
    expect(out.second).toBe("duplicate");
  });

  it("reports seen only after a claim", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* ProcessedEventStore;
        const before = yield* store.seen("evt-2");
        yield* store.claim("evt-2");
        const after = yield* store.seen("evt-2");
        const other = yield* store.seen("evt-unrelated");
        return { before, after, other };
      }),
    );
    expect(out.before).toBe(false);
    expect(out.after).toBe(true);
    expect(out.other).toBe(false);
  });
});
