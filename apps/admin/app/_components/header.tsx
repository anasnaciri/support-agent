import Link from "next/link";

import { logoutAction } from "@/app/logout/actions";

export function Header({ crumb }: { readonly crumb?: string }) {
  return (
    <header className="border-b border-zinc-800">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/" className="font-semibold hover:underline">
            Operator console
          </Link>
          {crumb ? (
            <>
              <span className="text-zinc-600">/</span>
              <span className="text-zinc-400">{crumb}</span>
            </>
          ) : null}
        </div>
        {/* POST via server action, never a GET link (S13). */}
        <form action={logoutAction}>
          <button
            type="submit"
            className="text-sm text-zinc-400 hover:text-zinc-100"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

const STATUS_TONE: Record<string, string> = {
  ready: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  connected: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  revoked: "bg-red-500/15 text-red-300 border-red-500/30",
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

export function StatusBadge({ status }: { readonly status: string | null }) {
  const tone =
    (status && STATUS_TONE[status]) ??
    "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${tone}`}
    >
      {status ?? "none"}
    </span>
  );
}
