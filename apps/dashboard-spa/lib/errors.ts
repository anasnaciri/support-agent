// Typed transport errors. The Next dashboard's api-client redirected (RSC
// `redirect()`) on auth/tenant failures; the SPA can't redirect from a fetch,
// so `call()` THROWS these and a global TanStack Query error handler maps them
// to router navigations (see main.tsx / query-client). Everything else (404,
// 400, write result codes) is returned to the caller as a normal result.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 401 after a refresh attempt — the session is gone; re-authenticate. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super("unauthorized", 401);
    this.name = "UnauthorizedError";
  }
}

/** 403 `no_tenant_for_organization` — the org has no workspace yet → onboarding. */
export class NoTenantError extends ApiError {
  constructor() {
    super("no_tenant_for_organization", 403);
    this.name = "NoTenantError";
  }
}

/** 403 `legal_acceptance_required` — the workspace must accept the latest terms. */
export class LegalRequiredError extends ApiError {
  constructor() {
    super("legal_acceptance_required", 403);
    this.name = "LegalRequiredError";
  }
}

/** 503 — the dashboard api/BFF isn't configured on this deployment. */
export class ApiConfigError extends ApiError {
  constructor() {
    super("dashboard_api_not_configured", 503);
    this.name = "ApiConfigError";
  }
}
