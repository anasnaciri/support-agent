import type {
  AdminTenantDetail,
  AdminTenantSummary,
} from "@support-agent/dashboard-contracts";

// Server-side client for apps/api's /admin/* endpoints. Holds the
// ADMIN_API_TOKEN (never shipped to the browser) and talks to the api origin.

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

const apiBase = (): string => {
  const v = process.env["ADMIN_API_BASE_URL"];
  if (!v || v.trim().length === 0) {
    throw new Error("ADMIN_API_BASE_URL is required (admin → api origin)");
  }
  return trimSlash(v.trim());
};

const apiToken = (): string => {
  const v = process.env["ADMIN_API_TOKEN"];
  if (!v || v.trim().length === 0) {
    throw new Error("ADMIN_API_TOKEN is required (admin → api operator token)");
  }
  return v.trim();
};

const request = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${apiBase()}/admin${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken()}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

const tid = (id: string): string => encodeURIComponent(id);

export const adminApi = {
  listTenants: async (): Promise<ReadonlyArray<AdminTenantSummary>> => {
    const res = await request("/tenants");
    if (!res.ok) throw new Error(`admin api ${res.status} on /tenants`);
    return ((await res.json()) as { tenants: ReadonlyArray<AdminTenantSummary> })
      .tenants;
  },

  tenantDetail: async (id: string): Promise<AdminTenantDetail | null> => {
    const res = await request(`/tenants/${tid(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`admin api ${res.status} on /tenants/${id}`);
    return (await res.json()) as AdminTenantDetail;
  },

  putShopifyApp: (
    id: string,
    clientId: string,
    clientSecret: string,
  ): Promise<Response> =>
    request(`/tenants/${tid(id)}/shopify-app`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    }),

  revokeShopifyApp: (id: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/shopify-app`, { method: "DELETE" }),

  deleteTenant: (id: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/delete`, { method: "POST" }),
};
