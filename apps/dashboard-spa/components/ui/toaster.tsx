"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * App-wide toast surface. Mounted once in the root layout; individual pages
 * raise toasts via `sonner`'s `toast()` (or the <FeedbackToaster/> bridge for
 * post-action feedback). `theme="light"` matches the dashboard's default
 * scheme — `.dark` is an opt-in variant nothing toggles today.
 */
export function Toaster() {
  return (
    <SonnerToaster
      theme="light"
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "rounded-lg border text-sm",
        },
      }}
    />
  );
}
