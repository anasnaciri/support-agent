import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import "@/app.css";

// Phase 0 scaffold entry: proves the toolchain (Vite + React 19 + Tailwind v4
// + TanStack Query + the copied shadcn UI primitives) renders and styles a
// page. The real router/providers land in Phase 2.
const queryClient = new QueryClient();

function Placeholder() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Guidezilla SPA
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Vite + React 19 + TanStack Query scaffold is live. The dashboard port
          builds from here.
        </p>
        <Button className="mt-6">Styled button</Button>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Placeholder />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
