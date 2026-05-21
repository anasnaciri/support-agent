import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "@support-agent/agent-core";
import {
  LLMCredentialResolver,
  LLMCredentialResolverTest,
  type LLMCredential,
} from "../src/llm-credential-resolver.js";

const tenantA = TenantId("00000000-0000-0000-0000-0000000000aa");
const tenantB = TenantId("00000000-0000-0000-0000-0000000000bb");
const tenantC = TenantId("00000000-0000-0000-0000-0000000000cc");

const credA: LLMCredential = {
  provider: "openrouter",
  apiKey: "sk-or-v1-aaaa",
};
const credB: LLMCredential = {
  provider: "anthropic",
  apiKey: "sk-ant-bbbb",
  baseURL: "https://anthropic.example",
};

describe("LLMCredentialResolverTest", () => {
  it("returns the configured credential for a known tenant", async () => {
    const layer = LLMCredentialResolverTest(
      new Map([
        [tenantA, credA],
        [tenantB, credB],
      ]),
    );
    const out = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const r = yield* LLMCredentialResolver;
          const a = yield* r.resolve(tenantA);
          const b = yield* r.resolve(tenantB);
          return [a, b];
        }),
        layer,
      ),
    );
    expect(out[0]).toEqual(credA);
    expect(out[1]).toEqual(credB);
  });

  it("fails with LLMCredentialMissing for a tenant with no entry", async () => {
    const layer = LLMCredentialResolverTest(
      new Map([[tenantA, credA]]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(LLMCredentialResolver, (r) => r.resolve(tenantC)),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = exit.cause;
      // Effect tagged-error: read the failure shape
      const str = JSON.stringify(cause);
      expect(str).toContain("LLMCredentialMissing");
    }
  });

  it("fails with LLMCredentialRevoked when the tenant entry is null", async () => {
    const layer = LLMCredentialResolverTest(
      new Map<TenantId, LLMCredential | null>([[tenantA, null]]),
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(LLMCredentialResolver, (r) => r.resolve(tenantA)),
        layer,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("LLMCredentialRevoked");
    }
  });
});
