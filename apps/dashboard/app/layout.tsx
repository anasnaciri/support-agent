import type { ReactNode } from "react";
import { cookies } from "next/headers";
import localFont from "next/font/local";

import { getSession } from "@/lib/session";
import { getShellWorkspaces } from "@/lib/api-client";
import { parseSidebarWidth } from "@/lib/sidebar-width";
import { Toaster } from "@/components/ui/toaster";
import { AppShell } from "./AppShell";
import "./globals.css";

// Display font for the Guidezilla wordmark. Exposed as a CSS variable so it
// can be applied to just the brand text (not the whole UI), which stays on the
// default sans.
const climateCrisis = localFont({
  src: "./ClimateCrisis-Regular-VariableFont_YEAR.ttf",
  variable: "--font-climate-crisis",
  display: "swap",
});

export const metadata = {
  title: "Guidezilla",
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
    <html
      lang="en"
      className={climateCrisis.variable}
      suppressHydrationWarning
    >
      <body
        className="min-h-screen bg-sidebar text-foreground antialiased"
        suppressHydrationWarning
      >
        <AppShell
          email={user?.email ?? null}
          workspaces={shellWorkspaces?.workspaces ?? null}
          activeWorkspaceId={shellWorkspaces?.activeWorkspaceId ?? null}
          permissions={shellWorkspaces?.permissions ?? null}
          defaultOpen={defaultOpen}
          defaultWidth={defaultWidth}
        >
          {children}
        </AppShell>
        <Toaster />
      </body>
    </html>
  );
}
