"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { IconRail } from "./IconRail";
import { SettingsNav } from "./settings/_components/settings-nav";

const SIDEBAR_COOKIE = "sidebar:state";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface SecondarySection {
  readonly title: string;
  readonly node: ReactNode;
}

interface Props {
  readonly email: string | null;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}

export function AppShell({ email, defaultOpen, children }: Props) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(defaultOpen);

  // Section-aware secondary sidebar. Settings is the first section to get
  // one; add more entries here as other sections grow sub-navigation.
  const secondary: SecondarySection | null = pathname.startsWith("/settings")
    ? { title: "Settings", node: <SettingsNav /> }
    : null;

  const setOpenPersisted = (next: boolean) => {
    setOpen(next);
    document.cookie = `${SIDEBAR_COOKIE}=${
      next ? "open" : "closed"
    }; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
  };

  return (
    <div className="flex h-screen overflow-hidden bg-sidebar">
      <IconRail email={email} />

      {/* pt-3 reveals a sliver of the dark frame so the off-white panel reads
          as floating, matching the rest of the app. */}
      <div className="flex min-w-0 flex-1 overflow-hidden pt-3">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-2xl bg-background">
          {secondary && open ? (
            <aside className="flex w-64 shrink-0 flex-col border-r border-border">
              <div className="flex items-center justify-between px-5 pb-2 pt-5">
                <h2 className="text-lg font-semibold tracking-tight">
                  {secondary.title}
                </h2>
                <button
                  type="button"
                  onClick={() => setOpenPersisted(false)}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                >
                  <PanelLeftClose className="size-4" aria-hidden />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {secondary.node}
              </div>
            </aside>
          ) : null}

          <main className="relative min-w-0 flex-1 overflow-y-auto px-8 py-8">
            {secondary && !open ? (
              <button
                type="button"
                onClick={() => setOpenPersisted(true)}
                className="absolute left-3 top-3 z-10 flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </button>
            ) : null}
            <div className="mx-auto w-full max-w-5xl">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
