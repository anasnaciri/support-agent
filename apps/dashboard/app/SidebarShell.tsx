"use client";

import { useState, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";

import { Sidebar } from "./Sidebar";

const SIDEBAR_COOKIE = "sidebar:state";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface Props {
  readonly email: string | null;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}

export function SidebarShell({ email, defaultOpen, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      document.cookie = `${SIDEBAR_COOKIE}=${
        next ? "open" : "closed"
      }; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
      return next;
    });
  };

  return (
    <div className="flex min-h-screen bg-sidebar">
      <div
        aria-hidden={!open}
        className={cn(
          "sticky top-0 h-screen shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out",
          open ? "w-64" : "w-0",
        )}
      >
        <Sidebar email={email} onToggle={toggle} />
      </div>
      <div className="relative flex-1">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "absolute left-3 top-3 z-50 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-200 ease-in-out hover:bg-accent/40 hover:text-foreground",
            open ? "pointer-events-none opacity-0" : "opacity-100",
          )}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          tabIndex={open ? -1 : 0}
        >
          <PanelLeftOpen className="size-4" aria-hidden />
        </button>
        <main
          className={cn(
            "min-h-screen bg-background px-8 py-8 transition-[margin-top,border-radius] duration-200 ease-in-out",
            open ? "mt-3 rounded-tl-2xl" : "mt-0 rounded-tl-none",
          )}
        >
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
