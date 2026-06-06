import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { DbClient, withTransaction } from "../src/index.js";
import type { DrizzleDb } from "../src/index.js";

// Unit tests (no real Postgres) for withTransaction's commit semantics. The
// regression target: withTransaction must NOT report success until the
// transaction actually COMMITS — a callback that succeeds but whose commit
// fails has to surface as a failure, not Success.

/**
 * A fake DrizzleDb exposing just `transaction(cb)`. `commitBehavior` decides
 * what happens AFTER the callback runs:
 *   - "ok":   resolves with the callback's return (commit succeeds)
 *   - "fail": rejects (commit fails) — the callback already ran
 */
const fakeDb = (commitBehavior: "ok" | "fail"): DrizzleDb => {
  const handle = {
    committed: false,
    rolledBack: false,
  };
  const db = {
    __handle: handle,
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      let value: T;
      try {
        value = await cb({});
      } catch (e) {
        handle.rolledBack = true;
        throw e;
      }
      if (commitBehavior === "fail") {
        handle.rolledBack = true;
        throw new Error("simulated commit failure");
      }
      handle.committed = true;
      return value;
    },
  };
  return db as unknown as DrizzleDb;
};

const runExit = <A, E>(eff: Effect.Effect<A, E, DbClient>, db: DrizzleDb) =>
  Effect.runPromiseExit(Effect.provide(eff, Layer.succeed(DbClient, db)));

describe("withTransaction — commit semantics", () => {
  it("reports success only after the commit succeeds", async () => {
    const db = fakeDb("ok");
    const exit = await runExit(withTransaction(Effect.succeed("value")), db);
    expect(exit).toStrictEqual(Exit.succeed("value"));
  });

  it("does NOT report success when the COMMIT fails (regression)", async () => {
    const db = fakeDb("fail");
    // Inner effect succeeds, but the commit then fails. Old code resumed
    // success from inside the callback and swallowed the commit error.
    const exit = await runExit(withTransaction(Effect.succeed("value")), db);
    expect(Exit.isFailure(exit)).toBe(true);
    // The transaction was rolled back, not committed.
    expect((db as unknown as { __handle: { committed: boolean } }).__handle.committed).toBe(
      false,
    );
  });

  it("fails (and rolls back) when the inner effect fails", async () => {
    const db = fakeDb("ok");
    const exit = await runExit(
      withTransaction(Effect.fail("inner-boom" as const)),
      db,
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("inner-boom");
    expect(
      (db as unknown as { __handle: { committed: boolean; rolledBack: boolean } })
        .__handle.committed,
    ).toBe(false);
    expect(
      (db as unknown as { __handle: { rolledBack: boolean } }).__handle
        .rolledBack,
    ).toBe(true);
  });
});
