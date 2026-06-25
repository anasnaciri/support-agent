"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { ResolvedToast } from "@/lib/toast-feedback";

/**
 * Fires the post-action toasts a server page resolved from its URL search
 * params, then strips those params from the address bar so a manual refresh
 * doesn't replay them. Renders nothing.
 *
 * Pair with `resolveFeedback` on the server: it produces the `toasts` to fire
 * and the `consume` keys to clear. Stripping uses `history.replaceState` (not
 * `router.replace`) so it doesn't trigger an RSC refetch — the page already
 * rendered its real state; the toast is a one-shot overlay on top.
 */
export function FeedbackToaster({
  toasts,
  consume = [],
}: {
  readonly toasts: readonly ResolvedToast[];
  readonly consume?: readonly string[];
}) {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (toasts.length === 0) return;
    fired.current = true;

    for (const t of toasts) {
      const options = {
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.action
          ? {
              action: {
                label: t.action.label,
                onClick: () => router.push(t.action!.href),
              },
            }
          : {}),
      };
      switch (t.kind) {
        case "success":
          toast.success(t.message, options);
          break;
        case "error":
          toast.error(t.message, options);
          break;
        case "warning":
          toast.warning(t.message, options);
          break;
        case "info":
          toast.info(t.message, options);
          break;
        default:
          toast(t.message, options);
      }
    }

    if (consume.length > 0 && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      let changed = false;
      for (const key of consume) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      if (changed) {
        const query = url.searchParams.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${query ? `?${query}` : ""}${url.hash}`,
        );
      }
    }
    // `toasts`/`consume` are derived from the request-time URL; fire exactly
    // once on mount. The ref guards against React StrictMode double-invoke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
