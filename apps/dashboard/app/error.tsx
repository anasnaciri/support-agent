"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface Props {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

// Route-level error boundary. Catches errors thrown from any Server
// Component on the page — most notably `NoTenantAccess` from
// `lib/tenant.ts` when the signed-in user isn't bound to a tenant.
//
// `error.name` is the Error class name; `NoTenantAccess` throws with
// `this.reason` set, but the reason is in `error.message` text by the
// time it crosses the server/client boundary. We parse the message to
// pick the right `?reason=` query so the no-access page can render the
// right copy.
export default function ErrorBoundary({ error, reset }: Props) {
  const router = useRouter();

  useEffect(() => {
    if (error.name === "NoTenantAccess") {
      const reason = error.message.includes("organization")
        ? "no_organization"
        : "no_tenant_mapping";
      router.replace(`/no-access?reason=${reason}`);
    }
  }, [error, router]);

  if (error.name === "NoTenantAccess") {
    return null;
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: "60px auto" }}>
      <h1>Something went wrong</h1>
      <p className="muted">{error.message}</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
