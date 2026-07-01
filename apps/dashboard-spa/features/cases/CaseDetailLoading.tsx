import { Skeleton } from "@/components/ui/skeleton";

// The case page blocks on caseDetail + Shopify + the conversation thread before
// painting; paint a skeleton that matches the inbox layout (chat center +
// details column) while the queries resolve. Rendered full-bleed inside
// AppShell's case-detail main, so it manages its own height like the page.
export function CaseDetailLoading() {
  return (
    <div className="flex h-full min-h-0" aria-busy aria-label="Loading case">
      {/* CENTER — conversation */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border/60 py-2.5 pl-4 pr-4 group-data-[sidebar-state=collapsed]/case:pl-14">
          <div className="min-w-0 space-y-1.5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-32" />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="size-9 rounded-md" />
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-hidden px-4 py-4">
          <div className="flex flex-col items-start gap-1">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-16 w-[70%] max-w-md rounded-2xl rounded-bl-sm" />
          </div>
          <div className="flex flex-col items-end gap-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-20 w-[75%] max-w-md rounded-2xl rounded-br-sm" />
          </div>
          <div className="flex flex-col items-start gap-1">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-12 w-[60%] max-w-md rounded-2xl rounded-bl-sm" />
          </div>
        </div>

        <div className="shrink-0 border-t border-border/60 px-4 py-3">
          <Skeleton className="h-[88px] w-full rounded-xl" />
        </div>
      </section>

      {/* RIGHT — details column (lg+ only, mirrors CaseDetailsPanel) */}
      <aside className="hidden w-80 shrink-0 border-l border-border/60 bg-muted/20 xl:w-96 lg:block">
        <div className="space-y-4 p-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </aside>
    </div>
  );
}
