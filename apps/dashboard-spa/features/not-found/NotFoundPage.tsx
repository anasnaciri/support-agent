import { Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-5 text-center">
        <p className="text-sm font-medium uppercase text-muted-foreground">
          404
        </p>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Page not found
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            The page you are looking for does not exist or has moved.
          </p>
        </div>
        <Button asChild>
          <Link href="/">
            <Home aria-hidden="true" />
            Back home
          </Link>
        </Button>
      </div>
    </main>
  );
}
