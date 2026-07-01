"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import {
  Button,
  buttonVariants,
  type ButtonProps,
} from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export interface ConfirmSubmitButtonProps
  extends Omit<ButtonProps, "type" | "title"> {
  /** Dialog heading, e.g. "Disconnect Gmail?". */
  readonly title: string;
  /** Dialog body explaining the consequence. */
  readonly description: string;
  /** Label on the confirming action button, e.g. "Disconnect". */
  readonly confirmLabel: string;
}

/**
 * A destructive-action submit button gated behind the branded AlertDialog
 * (U2 — same dialog PermissionToggle uses; never window.confirm). Render it
 * INSIDE the server-action `<form>` it should submit: the trigger opens the
 * dialog, and only the dialog's confirm button submits the form (via
 * `requestSubmit()` on the enclosing form — the portaled dialog content
 * lives outside the form element). While the action is pending the trigger
 * shows a spinner and is disabled (U3).
 */
export const ConfirmSubmitButton = ({
  title,
  description,
  confirmLabel,
  children,
  variant = "destructive",
  disabled,
  ...props
}: ConfirmSubmitButtonProps) => {
  const { pending } = useFormStatus();
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant={variant}
          disabled={pending || disabled}
          {...props}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant })}
            onClick={() =>
              triggerRef.current?.closest("form")?.requestSubmit()
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
