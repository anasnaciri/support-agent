import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  BlobNotFound,
  BlobStorageFailed,
  TenantId,
} from "@support-agent/agent-core";
import {
  BlobStorage,
  BlobStorageTest,
} from "../src/blob-storage.js";

const tenantId = TenantId("t1");

const useStorage = <A, E>(
  layer: ReturnType<typeof BlobStorageTest>,
  eff: (s: typeof BlobStorage.Service) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(Effect.flatMap(BlobStorage, eff), layer));

const useStorageExit = <A, E>(
  layer: ReturnType<typeof BlobStorageTest>,
  eff: (s: typeof BlobStorage.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(Effect.provide(Effect.flatMap(BlobStorage, eff), layer));

describe("BlobStorageTest", () => {
  it("put then get round-trips the bytes and content type", async () => {
    const layer = BlobStorageTest({});
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await useStorage(layer, (s) =>
      s.put({
        tenantId,
        key: "img/abc.png",
        bytes,
        contentType: "image/png",
      }),
    );
    const got = await useStorage(layer, (s) => s.get("img/abc.png"));
    expect(got.contentType).toBe("image/png");
    expect(Array.from(got.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("get fails with BlobNotFound for an unknown key", async () => {
    const layer = BlobStorageTest({});
    const exit = await useStorageExit(layer, (s) => s.get("missing"));
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobNotFound);
  });

  it("presignGetUrl returns a deterministic test URL containing the key", async () => {
    const layer = BlobStorageTest({});
    const bytes = new Uint8Array([7]);
    await useStorage(layer, (s) =>
      s.put({ tenantId, key: "evidence/x.jpg", bytes, contentType: "image/jpeg" }),
    );
    const url = await useStorage(layer, (s) =>
      s.presignGetUrl("evidence/x.jpg", 600),
    );
    expect(url).toContain("evidence/x.jpg");
    expect(url.startsWith("memory://")).toBe(true);
  });

  it("presignGetUrl fails with BlobNotFound when the key isn't in the store", async () => {
    const layer = BlobStorageTest({});
    const exit = await useStorageExit(layer, (s) =>
      s.presignGetUrl("ghost", 60),
    );
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobNotFound);
  });

  it("supports an override impl for forcing BlobStorageFailed in tests", async () => {
    const layer = BlobStorageTest({
      get: () =>
        Effect.fail(
          new BlobStorageFailed({ key: "x", cause: new Error("boom") }),
        ),
    });
    const exit = await useStorageExit(layer, (s) => s.get("x"));
    if (exit._tag !== "Failure") throw new Error("expected failure");
    if (exit.cause._tag !== "Fail") throw new Error("expected Fail cause");
    expect(exit.cause.error).toBeInstanceOf(BlobStorageFailed);
  });
});
