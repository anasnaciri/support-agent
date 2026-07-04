import { useState, type ReactNode } from "react";
import { PanelRightOpen, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The right-hand details column (customer / order / context / timeline).
 *
 *  - On `lg+` it's a static in-flow column beside the chat.
 *  - On smaller screens it becomes an off-canvas drawer: a slim tab on the
 *    right edge opens it over a scrim, so the details are reachable on a phone
 *    without stealing width from the conversation.
 *
 * The content is server-rendered and passed once as `children` (no duplicate
 * DOM) — only its presentation changes by breakpoint.
 */
export function TicketDetailsPanel({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile open tab — a slim handle on the right edge. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Show ticket details"
        title="Show ticket details"
        className="fixed right-0 top-1/2 z-30 flex h-16 w-7 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground lg:hidden"
      >
        <PanelRightOpen className="size-4" aria-hidden />
      </button>

      {/* Scrim — mobile only, behind the drawer. */}
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-foreground/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      <aside
        className={cn(
          "thin-scrollbar overflow-y-auto border-l border-border/60 bg-muted/40",
          // Mobile: fixed off-canvas drawer toggled by `open`.
          "fixed inset-y-0 right-0 z-40 w-80 max-w-[85vw] shadow-xl transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
          // Desktop: a static in-flow column, always visible.
          "lg:static lg:z-auto lg:w-72 lg:translate-x-0 lg:shadow-none xl:w-80 2xl:w-96",
        )}
      >
        {/* Mobile close button. */}
        <div className="flex justify-end p-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Hide ticket details"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}
