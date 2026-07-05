import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * A hover/focus tooltip whose panel is portaled to `document.body` and pinned
 * with `position: fixed`, so it escapes the context card's `overflow-y-auto`
 * clip instead of being cut off near the card's edges. A short close delay plus
 * the panel's own hover handlers let the pointer travel from trigger to panel
 * without dismissing it — the content stays interactive (e.g. ticket links the
 * operator can click).
 */
export function Tooltip({
  content,
  children,
  className,
  contentClassName,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    clearTimeout(closeTimer.current);
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.top - 6, left: r.left + r.width / 2 });
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), 80);
  }, []);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <span
      ref={triggerRef}
      className={cn("inline-flex max-w-full", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <span
              role="tooltip"
              onMouseEnter={show}
              onMouseLeave={hide}
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: "translate(-50%, -100%)",
              }}
              className={cn(
                "pointer-events-auto z-50 w-max max-w-[16rem] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-normal leading-snug text-popover-foreground shadow-md",
                contentClassName,
              )}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
