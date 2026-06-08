"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LEGAL_CONSENT_COOKIE } from "@/lib/legal-consent";

// Self-hosted sign-up gate. WorkOS's hosted UI can't enforce a custom legal
// checkbox, so we collect consent here, record it in a short-lived cookie, and
// THEN hand off to WorkOS (which, for a Google-only environment, bounces to
// Google). The /callback `onSuccess` hook reads the cookie and stamps the
// acceptance onto the WorkOS user. SameSite=Lax keeps the cookie present on the
// top-level GET navigation back to /callback.
export const startGoogleSignUp = async (
  _prev: { readonly error?: string } | null,
  formData: FormData,
): Promise<{ readonly error?: string }> => {
  if (formData.get("legalAccepted") !== "on") {
    return {
      error:
        "Accept the Data Processing Notice and Data Processing Addendum to continue.",
    };
  }

  const c = await cookies();
  c.set(LEGAL_CONSENT_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  // OpenNext/Cloudflare does not propagate the AuthKit PKCE Set-Cookie header
  // when a server action redirects directly off-origin. Hand off to a
  // same-origin GET route so the browser receives the verifier cookie first.
  redirect("/sign-up/start");
};
