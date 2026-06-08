import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { getSession } from "@/lib/session";
import { AppShell } from "./AppShell";
import "./globals.css";

export const metadata = {
  title: "Support Agent",
  description: "Manager surface for the AI Support Operations Platform.",
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { user } = await getSession();
  const cookieStore = await cookies();
  // Controls the secondary (contextual) sidebar; default open on first
  // visit. AppShell updates the cookie on every toggle so subsequent
  // reloads land in the same state without a server round-trip.
  const sidebarCookie = cookieStore.get("sidebar:state");
  const defaultOpen = sidebarCookie?.value !== "closed";

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="min-h-screen bg-sidebar text-foreground antialiased"
        suppressHydrationWarning
      >
        <AppShell email={user?.email ?? null} defaultOpen={defaultOpen}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
