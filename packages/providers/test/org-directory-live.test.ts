import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  OrgDirectoryDeleteFailed,
  OrgDirectoryService,
} from "@support-agent/services";
import {
  OrgDirectoryServiceLive,
  WorkosConfig,
} from "../src/org-directory-live.js";

const response = (status: number, ok: boolean, body = ""): Response =>
  ({
    ok,
    status,
    text: async () => body,
  }) as unknown as Response;

const configWith = (fetchImpl: typeof fetch): Layer.Layer<WorkosConfig> =>
  Layer.succeed(WorkosConfig, { apiKey: "sk_test_key", fetchImpl });

const runDelete = (fetchImpl: typeof fetch, orgId: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const dir = yield* OrgDirectoryService;
        return yield* Effect.either(dir.deleteOrganization(orgId));
      }),
      OrgDirectoryServiceLive.pipe(Layer.provide(configWith(fetchImpl))),
    ),
  );

describe("OrgDirectoryServiceLive — WorkOS", () => {
  it("DELETEs the org at the WorkOS endpoint with the bearer key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, true));

    const result = await runDelete(fetchImpl, "org_123");

    expect(result._tag).toBe("Right");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.workos.com/organizations/org_123");
    expect(init?.method).toBe("DELETE");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_key");
  });

  it("treats 404 (already deleted) as success — idempotent for retries", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(404, false, "not found"));

    const result = await runDelete(fetchImpl, "org_gone");

    expect(result._tag).toBe("Right");
  });

  it("maps a non-2xx (and non-404) into OrgDirectoryDeleteFailed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(500, false, "boom"));

    const result = await runDelete(fetchImpl, "org_500");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(OrgDirectoryDeleteFailed);
    }
  });
});
