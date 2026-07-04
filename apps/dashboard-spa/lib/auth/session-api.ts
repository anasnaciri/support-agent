import type { SessionUser } from "./types";
import { UnauthorizedError } from "../errors";

// The BFF auth endpoints (`/dashboard/auth/*`) live outside the workspace-scoped
// api-client transport: they take no workspace and drive full-page redirects
// (login/logout) or a plain whoami (session). apps/api owns the WorkOS handshake
// and the httpOnly cookie; the SPA never sees a token.

const apiOrigin = (): string => {
  const v = import.meta.env.VITE_API_BASE_URL;
  if (!v || v.trim().length === 0) {
    throw new Error("VITE_API_BASE_URL is required");
  }
  return v.trim().replace(/\/+$/u, "");
};

export interface AuthSession {
  readonly organizationId: string;
  /** Stable manager decision UUID (derived server-side from the verified sub). */
  readonly userId: string;
  readonly user: SessionUser;
  readonly needsOnboarding?: false;
}

/** Authenticated, but the user has no organization yet → show onboarding. */
export interface OnboardingRequired {
  readonly needsOnboarding: true;
  readonly userId: string;
  readonly user: SessionUser;
}

export type Whoami = AuthSession | OnboardingRequired;

export const isOnboardingRequired = (w: Whoami): w is OnboardingRequired =>
  w.needsOnboarding === true;

/**
 * Whoami — the current cookie session. Throws UnauthorizedError (401) when
 * signed out; returns an `OnboardingRequired` payload (200) when the user is
 * authenticated but has no org yet.
 */
export const getAuthSession = async (): Promise<Whoami> => {
  const res = await fetch(`${apiOrigin()}/dashboard/auth/session`, {
    credentials: "include",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`auth session ${res.status}`);
  return (await res.json()) as Whoami;
};

/** Thrown when onboarding fails; `.code` is the api's error slug. */
export class OnboardError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OnboardError";
  }
}

export interface OnboardInput {
  readonly name: string;
  readonly notificationEmail: string;
  readonly legalAccepted: boolean;
}

/**
 * Provision the org (server-side WorkOS) + re-mint the session cookie + create
 * the first tenant. On success the cookie now carries the org, so the SPA can
 * refetch the session/workspaces and enter the dashboard.
 */
export const onboard = async (input: OnboardInput): Promise<void> => {
  const res = await fetch(`${apiOrigin()}/dashboard/auth/onboard`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      origin: window.location.origin,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new OnboardError(body.error ?? `onboard_${res.status}`);
  }
};

/** Full-page redirect into the WorkOS handshake (apps/api owns the callback). */
export const login = (
  returnTo: string = window.location.pathname + window.location.search,
  screenHint?: "sign-up",
): void => {
  const url = new URL(`${apiOrigin()}/dashboard/auth/login`);
  url.searchParams.set("returnTo", returnTo);
  if (screenHint) url.searchParams.set("screen_hint", screenHint);
  window.location.assign(url.toString());
};

/**
 * POST-only sign-out (S13), then land on the goodbye page. `returnTo` lets the
 * account-deletion flow show a deletion-specific message (`/goodbye?deleted=1`).
 *
 * The api clears our cookie and hands back the WorkOS end-session URL; we must
 * NAVIGATE there so the AuthKit session cookie on the WorkOS domain dies too —
 * otherwise the next sign-in silently picks up the previous account. WorkOS
 * then redirects back to `returnTo`. If the api can't produce the URL (already
 * signed out, opaque token), fall back to landing on `returnTo` directly.
 */
export const logout = async (returnTo = "/goodbye"): Promise<void> => {
  let dest = returnTo;
  try {
    const res = await fetch(`${apiOrigin()}/dashboard/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        origin: window.location.origin,
      },
      body: JSON.stringify({ returnTo }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      logoutUrl?: string | null;
    };
    if (typeof body.logoutUrl === "string" && body.logoutUrl.length > 0) {
      dest = body.logoutUrl;
    }
  } finally {
    window.location.assign(dest);
  }
};
