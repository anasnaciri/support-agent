"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

// Top-level error boundary (U9). Next.js redacts `error.message` (and
// `error.name`) in production — only `digest` survives — so this renders
// actionable, generic copy instead of branching on redacted fields. (The old
// NoTenantAccess branch could never fire in prod and its throwing class was
// dead code; the auth gate redirects to /onboarding instead.)
export default function ErrorBoundary({ error, reset }: Props) {
  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This page hit an unexpected error. It's usually transient — try
            again, and if it keeps happening, reload the page or come back via
            the dashboard home.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={reset}>
              Try again
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link href="/">Go to dashboard</Link>
            </Button>
          </div>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              If you contact support, quote error reference{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                {error.digest}
              </code>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
