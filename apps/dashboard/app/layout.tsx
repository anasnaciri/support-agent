import type { ReactNode } from "react";
import Link from "next/link";
import { withAuth } from "@workos-inc/authkit-nextjs";
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
  // `withAuth()` reads the session cookie set by the AuthKit proxy.
  // The proxy redirects unauth'd requests to /sign-in before we ever
  // get here, so a null user inside an authed route means something
  // went wrong with cookie decryption — render an empty shell rather
  // than crashing.
  const { user } = await withAuth();

  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">Support Agent</Link>
          <nav>
            <Link href="/">Today</Link>
            <Link href="/cases">Cases</Link>
            <Link href="/approvals">Approvals</Link>
            <Link href="/audit">Audit</Link>
            <Link href="/settings">Settings</Link>
          </nav>
          <div className="account">
            {user?.email ? <span>{user.email}</span> : null}
            <Link href="/sign-out">Sign out</Link>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
