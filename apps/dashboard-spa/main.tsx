import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/router";
import { queryClient, setAuthErrorHandler } from "@/lib/query-client";
import { login } from "@/lib/auth/session-api";
import {
  LegalRequiredError,
  NoTenantError,
  UnauthorizedError,
} from "@/lib/errors";
import { Toaster } from "@/components/ui/toaster";
import "@/app.css";

// The RSC dashboard redirect()-ed on auth/tenant failures; the SPA routes the
// typed errors thrown by the api-client centrally: 401 → WorkOS login (full
// page), no-tenant → onboarding, legal-required → the legal settings page.
setAuthErrorHandler((error) => {
  if (error instanceof UnauthorizedError) {
    login();
  } else if (error instanceof NoTenantError) {
    void router.navigate({ to: "/onboarding" });
  } else if (error instanceof LegalRequiredError) {
    void router.navigate({ to: "/settings/legal" });
  }
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
