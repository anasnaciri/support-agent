import { Skeleton } from "@/components/ui/skeleton";

// Route-level loading state for the approvals list (U7).
export default function ApprovalsLoading() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading approvals">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-9 w-44" />

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
