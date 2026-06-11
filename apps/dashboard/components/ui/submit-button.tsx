"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";

export interface SubmitButtonProps extends Omit<ButtonProps, "type"> {
  /** Optional label swapped in while the action is pending ("Saving…"). */
  readonly pendingLabel?: React.ReactNode;
}

/**
 * The submit button for server-action `<form>`s (U3): disabled with a spinner
 * while the action is in flight, so slow actions give feedback and a double
 * click can't double-submit. Must be rendered INSIDE the form it submits —
 * `useFormStatus` reads the status of the nearest ancestor form.
 */
export const SubmitButton = ({
  children,
  pendingLabel,
  disabled,
  ...props
}: SubmitButtonProps) => {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </Button>
  );
};
