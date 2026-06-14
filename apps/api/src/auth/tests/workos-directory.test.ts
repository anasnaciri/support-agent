import { describe, expect, it, vi } from "vitest";

import {
  makeStaticWorkosUserDirectory,
  makeWorkosUserDirectory,
} from "../workos-directory.js";

// The api resolves a user's VERIFIED email from WorkOS (keyed on the verified
// `sub`) so invite reconciliation never trusts the spoofable x-user-email
// header. The lookup must fail soft — a WorkOS hiccup returns null (no
// reconcile) rather than throwing and breaking /me/session.
describe("makeWorkosUserDirectory (live)", () => {
  const okResponse = (email: unknown): Response =>
    ({ ok: true, json: async () => ({ email }) }) as unknown as Response;

  it("GETs the user-management user and returns its email + the right request", async () => {
    const fetchImpl = vi.fn(async () => okResponse("real@acme.com"));
    const dir = makeWorkosUserDirectory("sk_test_123", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_01ABC")).toBe("real@acme.com");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.workos.com/user_management/users/user_01ABC");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk_test_123",
    );
  });

  it("returns null on a non-2xx response (e.g. unknown user)", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("returns null when the payload has no string email", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => okResponse(null)) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("fails soft (null) when fetch throws — never breaks /me/session", async () => {
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await dir.getEmail("user_x")).toBeNull();
  });

  it("returns null for an empty id without calling out", async () => {
    const fetchImpl = vi.fn();
    const dir = makeWorkosUserDirectory("sk", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await dir.getEmail("")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("makeStaticWorkosUserDirectory (test/inject)", () => {
  it("resolves from the provided map", async () => {
    const dir = makeStaticWorkosUserDirectory((id) =>
      id === "user_sam" ? "sam@acme.com" : null,
    );
    expect(await dir.getEmail("user_sam")).toBe("sam@acme.com");
    expect(await dir.getEmail("user_other")).toBeNull();
  });
});
