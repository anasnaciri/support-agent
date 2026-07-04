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

export interface ConfirmButtonProps
  extends Omit<ButtonProps, "type" | "title" | "onClick"> {
  /** Dialog heading, e.g. "Reject this approval?". */
  readonly title: string;
  /** Dialog body explaining the consequence. */
  readonly description: string;
  /** Label on the confirming action button, e.g. "Reject & take over". */
  readonly confirmLabel: string;
  /** Fired only when the user confirms in the dialog. */
  readonly onConfirm: () => void;
  readonly pending?: boolean;
}

/**
 * A destructive/irreversible action gated behind the branded AlertDialog — the
 * SPA (callback-driven) counterpart of the Next ConfirmSubmitButton. The trigger
 * opens the dialog; only the dialog's confirm button runs `onConfirm`. While the
 * action is in flight the trigger shows a spinner and is disabled.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  children,
  variant = "destructive",
  disabled,
  ...props
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
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
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
