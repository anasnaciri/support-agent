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
}

/** Whoami — the current cookie session, or throws UnauthorizedError (401). */
export const getAuthSession = async (): Promise<AuthSession> => {
  const res = await fetch(`${apiOrigin()}/dashboard/auth/session`, {
    credentials: "include",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`auth session ${res.status}`);
  return (await res.json()) as AuthSession;
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

/** POST-only sign-out (S13), then land on the goodbye page. */
export const logout = async (): Promise<void> => {
  try {
    await fetch(`${apiOrigin()}/dashboard/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { origin: window.location.origin },
    });
  } finally {
    window.location.assign("/goodbye");
  }
};
