// Generic "ported soon" page for nav targets whose real pages land in Phase 3
// (reads) / Phase 4 (mutations). Keeps the router tree + nav complete so links
// resolve and the shell renders without 404s during the incremental port.
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">
        This page is being ported to the SPA.
      </p>
    </div>
  );
}
