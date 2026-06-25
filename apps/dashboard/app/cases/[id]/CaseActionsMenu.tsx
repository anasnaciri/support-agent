"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Loader2, MoreVertical } from "lucide-react";

import { cn } from "@/lib/utils";

export interface CaseMenuAction {
  readonly key: string;
  readonly label: string;
  /** Label swapped in while the action is in flight. */
  readonly pendingLabel: string;
  readonly title: string;
  readonly caseId: string;
  readonly action: (formData: FormData) => void | Promise<void>;
}

/**
 * The case-page overflow (⋮) menu. Each item is its own server-action `<form>`,
 * so submitting one behaves exactly like the header buttons (pending spinner,
 * redirect with banner). Renders nothing when there are no actions. The item
 * set is decided upstream by `caseActionMenuItems`.
 */
export const CaseActionsMenu = ({
  actions,
}: {
  readonly actions: ReadonlyArray<CaseMenuAction>;
}) => {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        className="inline-flex size-9 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <MoreVertical className="size-4" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[12rem] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {actions.map((a) => (
            <form key={a.key} action={a.action}>
              <input type="hidden" name="caseId" value={a.caseId} />
              <CaseMenuItem title={a.title} pendingLabel={a.pendingLabel}>
                {a.label}
              </CaseMenuItem>
            </form>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const CaseMenuItem = ({
  title,
  pendingLabel,
  children,
}: {
  readonly title: string;
  readonly pendingLabel: string;
  readonly children: React.ReactNode;
}) => {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      role="menuitem"
      title={title}
      disabled={pending}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </button>
  );
};
