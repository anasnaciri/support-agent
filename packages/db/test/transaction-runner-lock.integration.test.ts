import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TransactionRunner } from "@support-agent/services";
import { DbClientLive, TransactionRunnerLive } from "../src/index.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

// Audit L2 — per-ticket serialization. The workflow queue keys
// message.received by thread and approval/timer events by ticket, so two
// events for the SAME ticket can run concurrently across those keys (a
// customer reply racing the manager's approval → double reply). The
// runtime serializes ticks for one ticket behind a Postgres advisory
// lock; this pins the lock primitive itself.

describeIfDb("TransactionRunner.withLock — advisory-lock serialization", () => {
  const liveLayer = Layer.provideMerge(
    TransactionRunnerLive,
    DbClientLive({ databaseUrl: databaseUrl! }),
  );

  it("serializes concurrent effects holding the same key", async () => {
    const key = `ticket-lock-test:${randomUUID()}`;
    let inFlight = 0;
    let maxInFlight = 0;
    const events: string[] = [];

    const job = (name: string) =>
      Effect.gen(function* () {
        const tx = yield* TransactionRunner;
        yield* tx.withLock(
          key,
          Effect.gen(function* () {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            events.push(`${name}:start`);
            yield* Effect.promise(
              () => new Promise((r) => setTimeout(r, 50)),
            );
            events.push(`${name}:end`);
            inFlight -= 1;
          }),
        );
      });

    await Effect.runPromise(
      Effect.provide(
        Effect.all([job("a"), job("b"), job("c")], {
          concurrency: "unbounded",
        }),
        liveLayer,
      ).pipe(Effect.scoped) as Effect.Effect<unknown, never, never>,
    );

    // Never two holders of the same key at once.
    expect(maxInFlight).toBe(1);
    // Every start is immediately followed by its own end.
    for (let i = 0; i < events.length; i += 2) {
      const start = events[i]!;
      const end = events[i + 1]!;
      expect(start.endsWith(":start")).toBe(true);
      expect(end).toBe(start.replace(":start", ":end"));
    }
  });

  it("different keys do not block each other", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const job = (key: string) =>
      Effect.gen(function* () {
        const tx = yield* TransactionRunner;
        yield* tx.withLock(
          key,
          Effect.gen(function* () {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            yield* Effect.promise(
              () => new Promise((r) => setTimeout(r, 50)),
            );
            inFlight -= 1;
          }),
        );
      });

    await Effect.runPromise(
      Effect.provide(
        Effect.all(
          [job(`k1:${randomUUID()}`), job(`k2:${randomUUID()}`)],
          { concurrency: "unbounded" },
        ),
        liveLayer,
      ).pipe(Effect.scoped) as Effect.Effect<unknown, never, never>,
    );

    expect(maxInFlight).toBe(2);
  });

  it("releases the lock when the inner effect fails", async () => {
    const key = `ticket-lock-fail:${randomUUID()}`;
    const failing = Effect.gen(function* () {
      const tx = yield* TransactionRunner;
      yield* tx.withLock(key, Effect.fail(new Error("boom")));
    });
    const after = Effect.gen(function* () {
      const tx = yield* TransactionRunner;
      yield* tx.withLock(key, Effect.void);
    });

    const firstExit = await Effect.runPromiseExit(
      Effect.provide(failing, liveLayer).pipe(Effect.scoped) as Effect.Effect<
        unknown,
        unknown,
        never
      >,
    );
    expect(firstExit._tag).toBe("Failure");

    // Must not deadlock — the failed holder released the lock.
    await Effect.runPromise(
      Effect.provide(after, liveLayer).pipe(Effect.scoped) as Effect.Effect<
        unknown,
        never,
        never
      >,
    );
  });
});
