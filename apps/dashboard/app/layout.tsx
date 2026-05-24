import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { withAuth } from "@workos-inc/authkit-nextjs";

import { SidebarShell } from "./SidebarShell";
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
  const { user } = await withAuth();
  const cookieStore = await cookies();
  // Default to open on first visit; the SidebarShell client component
  // updates the cookie on every toggle so subsequent reloads land in
  // the same state without a server round-trip.
  const sidebarCookie = cookieStore.get("sidebar:state");
  const defaultOpen = sidebarCookie?.value !== "closed";

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className="min-h-screen bg-sidebar text-foreground antialiased"
        suppressHydrationWarning
      >
        <SidebarShell email={user?.email ?? null} defaultOpen={defaultOpen}>
          {children}
        </SidebarShell>
      </body>
    </html>
  );
}
