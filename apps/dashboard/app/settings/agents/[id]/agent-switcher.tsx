"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { AgentSwitcherOption } from "./agent-switcher-data";

export interface AgentSwitcherProps {
  readonly options: ReadonlyArray<AgentSwitcherOption>;
  /** The name shown on the trigger — the agent currently being viewed. */
  readonly currentName: string;
}

const modeVariant = (mode: string): "info" | "secondary" =>
  mode === "primary" ? "info" : "secondary";

// The page <h1> rendered as a dropdown trigger: clicking the agent name opens
// a list of every agent and navigates to the picked one. Modeled on
// ModelCombobox's open/click-outside handling; navigation goes through the
// router so it's a client-side push, not a full reload.
export const AgentSwitcher = ({ options, currentName }: AgentSwitcherProps) => {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (href: string, current: boolean) => {
    setOpen(false);
    if (!current) router.push(href);
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="group inline-flex items-center gap-2 rounded-md text-3xl font-semibold tracking-tight transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span>{currentName}</span>
        <ChevronDown
          className={cn(
            "size-5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 z-50 mt-2 max-h-[360px] w-[320px] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
        >
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => go(o.href, o.current)}
              role="option"
              aria-selected={o.current}
              className={cn(
                "flex w-full items-start justify-between gap-3 rounded-sm px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground",
                o.current && "bg-accent/60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{o.name}</span>
                  <Badge variant={modeVariant(o.mode)}>{o.mode}</Badge>
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {o.id}
                </div>
              </div>
              {o.current ? (
                <Check
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
