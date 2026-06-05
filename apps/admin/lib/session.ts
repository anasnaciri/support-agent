import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  signSessionValue,
  verifySessionValue,
} from "./session-crypto";

/** Set the signed session cookie after a successful password login. */
export async function setSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, signSessionValue(Date.now()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE)?.value, Date.now());
}

/** Guard a protected page/action — bounce to /login when unauthenticated. */
export async function requireSession(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
