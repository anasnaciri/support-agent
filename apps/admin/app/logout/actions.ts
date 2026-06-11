"use server";

import { redirect } from "next/navigation";

import { clearSessionCookie } from "@/lib/session";

// Logout is a server action, not a GET route (S13): it mutates state (clears
// the operator session cookie), so it must not be triggerable by a drive-by
// GET or link prefetch.
export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
