"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";

import { NativeSelect } from "@/components/ui/native-select";

export interface StatusOption {
  readonly value: string;
  readonly label: string;
}

export interface StatusSelectProps {
  readonly caseId: string;
  /** The case's current status — the pre-selected, "(current)" option. */
  readonly currentValue: string;
  readonly currentLabel: string;
  /** The statuses a person may move this case to (matrix-validated upstream). */
  readonly options: ReadonlyArray<StatusOption>;
  readonly action: (formData: FormData) => void | Promise<void>;
}

/**
 * The case-status picker. Picking a different status fires `setStatusAction`
 * immediately — there's no separate confirm button. The action re-validates the
 * move against the case state machine and redirects with the outcome banner;
 * re-picking the current value is a no-op.
 */
export const StatusSelect = ({
  caseId,
  currentValue,
  currentLabel,
  options,
  action,
}: StatusSelectProps) => {
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} title="Change this case's status">
      <input type="hidden" name="caseId" value={caseId} />
      <StatusSelectField
        currentValue={currentValue}
        currentLabel={currentLabel}
        options={options}
        onPick={(value) => {
          if (value !== currentValue) formRef.current?.requestSubmit();
        }}
      />
    </form>
  );
};

const StatusSelectField = ({
  currentValue,
  currentLabel,
  options,
  onPick,
}: {
  readonly currentValue: string;
  readonly currentLabel: string;
  readonly options: ReadonlyArray<StatusOption>;
  readonly onPick: (value: string) => void;
}) => {
  // Disable the picker while the change is in flight so a slow action can't be
  // double-submitted. Reads the nearest ancestor form's status (U3).
  const { pending } = useFormStatus();
  return (
    <NativeSelect
      name="status"
      defaultValue={currentValue}
      aria-label="Change case status"
      disabled={pending}
      className="h-9 w-auto min-w-[10rem]"
      onChange={(e) => onPick(e.currentTarget.value)}
    >
      <option value={currentValue}>{currentLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  );
};
