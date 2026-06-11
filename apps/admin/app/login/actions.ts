"use server";

import { redirect } from "next/navigation";

import { passwordMatches } from "@/lib/session-crypto";
import { sharedThrottle } from "@/lib/login-throttle";
import { setSessionCookie } from "@/lib/session";

// Login attempts run through the in-memory throttle (S10): after a few
// consecutive failures, attempts are refused with exponential backoff —
// the password isn't even compared while locked. The throttle is global
// (single shared password, single-instance operator app).
export async function loginAction(formData: FormData): Promise<void> {
  const now = Date.now();
  const waitMs = sharedThrottle.retryAfterMs(now);
  if (waitMs > 0) {
    redirect(`/login?error=locked&retry=${Math.ceil(waitMs / 1000)}`);
  }

  const password = String(formData.get("password") ?? "");
  if (!passwordMatches(password)) {
    sharedThrottle.recordFailure(now);
    redirect("/login?error=1");
  }
  sharedThrottle.recordSuccess();
  await setSessionCookie();
  redirect("/");
}
