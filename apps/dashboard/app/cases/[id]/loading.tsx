import { Skeleton } from "@/components/ui/skeleton";

// Route-level loading state (U7): the case page blocks on caseDetail + a live
// Shopify call before painting, so paint a layout-matching skeleton instantly.
export default function CaseDetailLoading() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading case">
      {/* Breadcrumb */}
      <Skeleton className="h-4 w-48" />

      {/* Title row + status line */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="ml-auto h-9 w-28" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>

      {/* Customer / order panels */}
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>

      {/* Timeline */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    </div>
  );
}
