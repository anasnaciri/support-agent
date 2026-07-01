import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

// Drop-in for next/link: accepts `href` and does client-side navigation on a
// plain left-click (honoring modifier keys + target for new-tab), so ported
// components only change their import. A plain <a> (not TanStack's <Link>) keeps
// arbitrary anchor props clean under exactOptionalPropertyTypes.
type LinkProps = {
  readonly href: string;
  readonly children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export function Link({ href, children, onClick, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (rest.target && rest.target !== "_self") return;
    e.preventDefault();
    void navigate({ to: href });
  };
  return (
    <a href={href} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

export default Link;
