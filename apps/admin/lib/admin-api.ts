import type {
  AdminAccountDetail,
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

  accountDetail: async (
    organizationId: string,
  ): Promise<AdminAccountDetail | null> => {
    const res = await request(`/accounts/${tid(organizationId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`admin api ${res.status} on /accounts/${organizationId}`);
    }
    return (await res.json()) as AdminAccountDetail;
  },

  putAccountOpenRouter: (
    organizationId: string,
    apiKey: string,
  ): Promise<Response> =>
    request(`/accounts/${tid(organizationId)}/openrouter`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }),

  revokeAccountOpenRouter: (organizationId: string): Promise<Response> =>
    request(`/accounts/${tid(organizationId)}/openrouter`, {
      method: "DELETE",
    }),

  putWorkspaceOpenRouter: (id: string, apiKey: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/openrouter`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }),

  revokeWorkspaceOpenRouter: (id: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/openrouter`, { method: "DELETE" }),

  putShopifyApp: (
    id: string,
    clientId: string,
    clientSecret: string,
    shopDomain?: string,
    installLink?: string,
  ): Promise<Response> =>
    request(`/tenants/${tid(id)}/shopify-app`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        ...(shopDomain ? { shopDomain } : {}),
        ...(installLink ? { installLink } : {}),
      }),
    }),

  revokeShopifyApp: (id: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/shopify-app`, { method: "DELETE" }),

  deleteTenant: (id: string): Promise<Response> =>
    request(`/tenants/${tid(id)}/delete`, { method: "POST" }),

  // Run the live protected-customer-data probe and normalize the api's
  // result into a single verdict code the UI can map to a message.
  checkShopifyPcd: async (id: string): Promise<PcdCheckVerdict> => {
    const res = await request(`/tenants/${tid(id)}/shopify-app/pcd-check`, {
      method: "POST",
    });
    if (res.status === 404) return "tenant_not_found";
    if (!res.ok) return "error";
    const body = (await res.json()) as {
      result?: { kind?: string; verdict?: string };
    };
    const r = body.result;
    if (!r) return "error";
    if (r.kind === "not_connected") return "not_connected";
    if (r.kind === "tenant_not_found") return "tenant_not_found";
    if (r.kind === "summary") {
      const v = r.verdict;
      return v === "present" || v === "redacted" || v === "no_orders"
        ? v
        : "error";
    }
    return "error";
  },
};

export type PcdCheckVerdict =
  | "present"
  | "redacted"
  | "no_orders"
  | "not_connected"
  | "tenant_not_found"
  | "error";
