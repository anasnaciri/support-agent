"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

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
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{error.message}</p>
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
