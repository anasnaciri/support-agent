import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { PgBoss } from "../src/queue.js";
import {
  DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
  DEFAULT_WORKFLOW_QUEUE_NAME,
  ensureWorkflowQueue,
} from "../src/workflow-queue-live.js";

describe("ensureWorkflowQueue", () => {
  it("reconciles existing pg-boss queue options after creation", async () => {
    const calls: Array<{
      readonly method: "createQueue" | "updateQueue";
      readonly name: string;
      readonly options: unknown;
    }> = [];
    const boss = {
      createQueue: async (name: string, options: unknown) => {
        calls.push({ method: "createQueue", name, options });
      },
      updateQueue: async (name: string, options: unknown) => {
        calls.push({ method: "updateQueue", name, options });
      },
    } as unknown as PgBoss;

    await Effect.runPromise(ensureWorkflowQueue(boss));

    expect(calls).toEqual([
      {
        method: "createQueue",
        name: DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
        options: expect.objectContaining({
          policy: "standard",
          retryLimit: 3,
          retryBackoff: true,
        }),
      },
      {
        method: "updateQueue",
        name: DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
        options: expect.objectContaining({
          retryLimit: 3,
          retryBackoff: true,
        }),
      },
      {
        method: "createQueue",
        name: DEFAULT_WORKFLOW_QUEUE_NAME,
        options: expect.objectContaining({
          policy: "key_strict_fifo",
          retryLimit: 5,
          retryBackoff: true,
          deleteAfterSeconds: 3600,
          deadLetter: DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
        }),
      },
      {
        method: "updateQueue",
        name: DEFAULT_WORKFLOW_QUEUE_NAME,
        options: expect.objectContaining({
          retryLimit: 5,
          retryBackoff: true,
          deleteAfterSeconds: 3600,
          deadLetter: DEFAULT_WORKFLOW_DEAD_LETTER_QUEUE,
        }),
      },
    ]);
  });
});
