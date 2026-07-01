import { login } from "@/lib/auth/session-api";
import { Button } from "@/components/ui/button";

// Public shell for the auth/landing routes. The real onboarding form + legal
// gate land in Phase 4; these are the minimal routes the guards navigate to.

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-sm space-y-4 text-center">{children}</div>
    </div>
  );
}

export function SignInPage() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold tracking-tight">Guidezilla</h1>
      <p className="text-sm text-muted-foreground">
        Sign in to your support workspace.
      </p>
      <Button className="w-full" onClick={() => login("/")}>
        Sign in
      </Button>
      <button
        type="button"
        onClick={() => login("/", "sign-up")}
        className="text-sm text-primary hover:underline"
      >
        Create an account
      </button>
    </Centered>
  );
}

export function GoodbyePage() {
  return (
    <Centered>
      <h1 className="text-xl font-semibold tracking-tight">Signed out</h1>
      <p className="text-sm text-muted-foreground">You’ve been signed out.</p>
      <Button className="w-full" onClick={() => login("/")}>
        Sign in again
      </Button>
    </Centered>
  );
}

export function NoAccessPage() {
  return (
    <Centered>
      <h1 className="text-xl font-semibold tracking-tight">No access</h1>
      <p className="text-sm text-muted-foreground">
        Your account isn’t part of a workspace yet. Ask an admin for an invite.
      </p>
    </Centered>
  );
}

export function OnboardingPage() {
  return (
    <Centered>
      <h1 className="text-xl font-semibold tracking-tight">
        Set up your workspace
      </h1>
      <p className="text-sm text-muted-foreground">
        Onboarding is coming soon in the SPA. (Ported in Phase 4.)
      </p>
    </Centered>
  );
}
