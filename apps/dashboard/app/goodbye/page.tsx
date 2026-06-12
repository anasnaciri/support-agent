import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

// Public landing after an account is deleted — the manager has been signed
// out and their tenant + org no longer exist, so this page must NOT call
// any tenant-scoped data or the auth gate.
export default function GoodbyePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">
          Your account has been deleted
        </h1>
        <p className="text-sm text-muted-foreground">
          Your account and all associated data have been permanently removed. A
          confirmation has been emailed to the address on file. Thanks for
          trying the platform.
        </p>
        <Button asChild variant="outline">
          <Link href="/sign-up">Create a new account</Link>
        </Button>
      </div>
    </main>
  );
}
