import { redirect } from "next/navigation";

import { isAuthenticated } from "@/lib/session";
import { SubmitButton } from "@/app/_components/submit-button";
import { loginAction } from "./actions";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function LoginPage({ searchParams }: PageProps) {
  if (await isAuthenticated()) redirect("/");
  const params = (await searchParams) ?? {};
  const errorParam = params["error"];
  const error = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const retryParam = params["retry"];
  const retry = Array.isArray(retryParam) ? retryParam[0] : retryParam;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Operator console</h1>
          <p className="text-sm text-zinc-400">
            Support Agent platform administration
          </p>
        </div>
        <form action={loginAction} className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm text-zinc-300">
              Operator password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
          </div>
          {error === "locked" ? (
            <p className="text-sm text-red-400">
              Too many failed attempts. Try again in {retry ?? "a few"} seconds.
            </p>
          ) : error ? (
            <p className="text-sm text-red-400">Incorrect password.</p>
          ) : null}
          <SubmitButton
            pendingLabel="Signing in…"
            className="w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
          >
            Sign in
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}
