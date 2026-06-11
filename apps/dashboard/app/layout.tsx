import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { getSession } from "@/lib/session";
import { getShellWorkspaces } from "@/lib/api-client";
import { parseSidebarWidth } from "@/lib/sidebar-width";
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
  // Tolerant fetch (null on signed-out / pre-onboarding / api hiccup) — the
  // layout wraps auth routes too, so this must never redirect or throw.
  const shellWorkspaces = await getShellWorkspaces();
  const cookieStore = await cookies();
  // Controls the secondary (contextual) sidebar; default open on first
  // visit. AppShell updates the cookie on every toggle so subsequent
  // reloads land in the same state without a server round-trip.
  const sidebarCookie = cookieStore.get("sidebar:state");
  const defaultOpen = sidebarCookie?.value !== "closed";
  const defaultWidth = parseSidebarWidth(cookieStore.get("sidebar:width")?.value);

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="min-h-screen bg-sidebar text-foreground antialiased"
        suppressHydrationWarning
      >
        <AppShell
          email={user?.email ?? null}
          workspaces={shellWorkspaces?.workspaces ?? null}
          activeWorkspaceId={shellWorkspaces?.activeWorkspaceId ?? null}
          defaultOpen={defaultOpen}
          defaultWidth={defaultWidth}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
