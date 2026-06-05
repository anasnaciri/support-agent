import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Support Agent — Admin",
  description: "Platform-operator console for the AI Support Operations Platform.",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  );
}
