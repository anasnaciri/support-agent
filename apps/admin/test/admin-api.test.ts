import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../lib/admin-api.js";

const base = "https://api.example.test";

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("admin-api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Trailing slash to exercise the base-url trim.
    process.env["ADMIN_API_BASE_URL"] = `${base}/`;
    process.env["ADMIN_API_TOKEN"] = "tok";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lastCall = (): [string, RequestInit] =>
    fetchMock.mock.calls[0] as [string, RequestInit];

  it("listTenants GETs /admin/tenants with the operator bearer token", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { tenants: [{ id: "t1" }] }));
    const tenants = await adminApi.listTenants();
    expect(tenants).toEqual([{ id: "t1" }]);
    const [url, init] = lastCall();
    expect(url).toBe(`${base}/admin/tenants`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("tenantDetail returns null on 404", async () => {
    fetchMock.mockResolvedValue(jsonRes(404, { error: "tenant_not_found" }));
    expect(await adminApi.tenantDetail("t9")).toBeNull();
  });

  it("tenantDetail returns the body on 200", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { tenant: { id: "t1" } }));
    const detail = await adminApi.tenantDetail("t1");
    expect(detail).toMatchObject({ tenant: { id: "t1" } });
    expect(lastCall()[0]).toBe(`${base}/admin/tenants/t1`);
  });

  it("putShopifyApp sends a JSON PUT with the credentials", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }));
    await adminApi.putShopifyApp("t1", "cid", "secret");
    const [url, init] = lastCall();
    expect(url).toBe(`${base}/admin/tenants/t1/shopify-app`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      clientId: "cid",
      clientSecret: "secret",
    });
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("putShopifyApp includes shopDomain when provided", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }));
    await adminApi.putShopifyApp("t1", "cid", "secret", "acme.myshopify.com");
    const [, init] = lastCall();
    expect(JSON.parse(String(init.body))).toEqual({
      clientId: "cid",
      clientSecret: "secret",
      shopDomain: "acme.myshopify.com",
    });
  });

  it("revokeShopifyApp DELETEs the shopify-app endpoint", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }));
    await adminApi.revokeShopifyApp("t1");
    const [url, init] = lastCall();
    expect(url).toBe(`${base}/admin/tenants/t1/shopify-app`);
    expect(init.method).toBe("DELETE");
  });

  it("deleteTenant POSTs the delete endpoint", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }));
    await adminApi.deleteTenant("t1");
    const [url, init] = lastCall();
    expect(url).toBe(`${base}/admin/tenants/t1/delete`);
    expect(init.method).toBe("POST");
  });

  it("checkShopifyPcd POSTs the pcd-check endpoint and returns the verdict", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { ok: true, result: { kind: "summary", verdict: "redacted" } }),
    );
    const verdict = await adminApi.checkShopifyPcd("t1");
    expect(verdict).toBe("redacted");
    const [url, init] = lastCall();
    expect(url).toBe(`${base}/admin/tenants/t1/shopify-app/pcd-check`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("checkShopifyPcd maps a not_connected result", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { ok: true, result: { kind: "not_connected" } }),
    );
    expect(await adminApi.checkShopifyPcd("t1")).toBe("not_connected");
  });

  it("checkShopifyPcd maps a 404 to tenant_not_found", async () => {
    fetchMock.mockResolvedValue(jsonRes(404, { error: "tenant_not_found" }));
    expect(await adminApi.checkShopifyPcd("t9")).toBe("tenant_not_found");
  });
});
