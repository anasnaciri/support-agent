"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";

export interface SubmitButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** Optional label swapped in while the action is pending. */
  readonly pendingLabel?: React.ReactNode;
}

/**
 * Submit button for the admin app's server-action forms (U3): disabled with
 * a subtle "working" state while the action runs, so slow operations (PCD
 * check, tenant delete) give feedback and can't be double-submitted. Styling
 * is passed through `className` — the admin app has no shadcn kit.
 */
export const SubmitButton = ({
  children,
  pendingLabel,
  className,
  disabled,
  ...props
}: SubmitButtonProps) => {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-60`}
      {...props}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
};
