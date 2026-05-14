import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeQueue, type PgBoss } from "../src/queue.js";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("pg-boss (integration)", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = await makeQueue({
      databaseUrl: databaseUrl!,
      schema: "pgboss_test",
    });
  }, 30_000);

  afterAll(async () => {
    if (boss) {
      await boss.stop({ graceful: true, wait: false });
    }
  });

  it("starts, declares a queue, sends and consumes one job", async () => {
    const queueName = "test.echo";
    await boss.createQueue(queueName);

    const received: Array<{ payload: unknown }> = [];
    const resolved = new Promise<void>((resolve) => {
      void boss.work<{ msg: string }>(queueName, async (jobs) => {
        for (const job of jobs) {
          received.push({ payload: job.data });
        }
        resolve();
      });
    });

    await boss.send(queueName, { msg: "hello" });
    await Promise.race([
      resolved,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("worker timeout")), 10_000),
      ),
    ]);

    expect(received).toEqual([{ payload: { msg: "hello" } }]);
  }, 30_000);
});
