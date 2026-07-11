import { useBlocker } from "@tanstack/react-router";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Holds the user back while a form on the page has changes they haven't saved:
 * a confirm dialog for navigation inside the app, and the browser's own prompt
 * for a reload or a closed tab (`enableBeforeUnload`).
 */
export function UnsavedChangesPrompt({
  dirty,
  description = "Your changes haven't been saved yet. Leave this page and you'll lose them.",
}: {
  readonly dirty: boolean;
  readonly description?: string;
}) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    disabled: !dirty,
    withResolver: true,
  });

  const blocked = blocker.status === "blocked";

  return (
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.reset?.()}>
            Stay on this page
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={() => blocker.proceed?.()}
          >
            Leave and discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
