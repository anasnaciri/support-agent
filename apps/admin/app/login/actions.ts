"use server";

import { redirect } from "next/navigation";

import { passwordMatches } from "@/lib/session-crypto";
import { setSessionCookie } from "@/lib/session";

export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (!passwordMatches(password)) {
    redirect("/login?error=1");
  }
  await setSessionCookie();
  redirect("/");
}
