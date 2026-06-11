import { Skeleton } from "@/components/ui/skeleton";

// Shared route-level loading state for every /settings/* page (U7): heading +
// stacked cards matches the section's common layout closely enough.
export default function SettingsLoading() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading settings">
      <Skeleton className="h-4 w-40" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
    </div>
  );
}
