import { useLocation, useNavigate } from "@tanstack/react-router";

// Thin shims replacing next/navigation so ported components change only their
// import line. We deliberately do NOT register the route tree type (keeping
// TanStack Router's `to` loose as `string`), so these accept arbitrary paths.

/** Drop-in for next/navigation `usePathname`. */
export const usePathname = (): string =>
  useLocation({ select: (l) => l.pathname });

/** A minimal next/navigation-style router (push/replace) over TanStack Router. */
export const useAppNavigate = (): {
  push: (to: string) => void;
  replace: (to: string) => void;
} => {
  const navigate = useNavigate();
  return {
    push: (to) => void navigate({ to }),
    replace: (to) => void navigate({ to, replace: true }),
  };
};
