import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api-client";
import { ApiError, LegalRequiredError, NoTenantError } from "../lib/errors";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("dashboard SPA api-client auth error mapping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("maps only the no-tenant 403 to the onboarding redirect error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: "no_tenant_for_organization" }),
    );

    await expect(
      api.models({ workspaceId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toBeInstanceOf(NoTenantError);
  });

  it("maps legal 403s to the legal settings redirect error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: "legal_acceptance_required" }),
    );

    await expect(
      api.models({ workspaceId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toBeInstanceOf(LegalRequiredError);
  });

  it("does not send generic permission 403s to onboarding", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: "permission_denied" }),
    );

    try {
      await api.models({
        workspaceId: "11111111-1111-4111-8111-111111111111",
      });
      throw new Error("expected api.models to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(NoTenantError);
      expect((err as ApiError).status).toBe(403);
    }
  });
});
