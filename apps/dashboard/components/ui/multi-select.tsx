"use client";

import { Check, ChevronDown } from "lucide-react";
import * as React from "react";

import { multiSelectLabel } from "@/lib/approvals-filters";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  readonly label: string;
  readonly value: string;
}

export interface MultiSelectProps {
  /** Hidden field name. One hidden <input> is rendered per selected value so a
   *  plain `<form method="get">` submit ships them as repeated query keys. */
  readonly name: string;
  /** Currently selected values. */
  readonly values: ReadonlyArray<string>;
  readonly options: ReadonlyArray<MultiSelectOption>;
  /** Trigger text when nothing is selected (e.g. "Any risk"). */
  readonly placeholder: string;
  /** When set, renders a leading select-all row with this label. Clicking it
   *  checks every option (or clears them if all are already checked); it shows
   *  as checked — and becomes the trigger label — when all options are on. */
  readonly allLabel?: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

export const MultiSelect = ({
  name,
  values,
  options,
  placeholder,
  allLabel,
  id,
  disabled,
}: MultiSelectProps) => {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<ReadonlyArray<string>>(values);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const toggle = (value: string) => {
    setSelected((prev) =>
      prev.includes(value)
        ? prev.filter((v) => v !== value)
        : [...prev, value],
    );
  };

  const allValues = options.map((o) => o.value);
  const allSelected =
    allValues.length > 0 && allValues.every((v) => selected.includes(v));
  const toggleAll = () => setSelected(allSelected ? [] : allValues);

  const selectedLabels = options
    .filter((o) => selected.includes(o.value))
    .map((o) => o.label);
  const label =
    allLabel && allSelected
      ? allLabel
      : multiSelectLabel(selectedLabels, placeholder);

  return (
    <div ref={containerRef} className="relative">
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <button
        type="button"
        id={id}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span
          className={cn(
            "truncate text-left",
            selectedLabels.length === 0 && "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className="ml-2 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 z-50 mt-1 max-h-[300px] overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          role="listbox"
          aria-multiselectable
        >
          {allLabel ? (
            <button
              type="button"
              onClick={toggleAll}
              className={cn(
                "flex w-full items-center justify-between gap-3 border-b px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                allSelected && "bg-accent/60",
              )}
              role="option"
              aria-selected={allSelected}
            >
              <span className="truncate">{allLabel}</span>
              {allSelected ? (
                <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
              ) : null}
            </button>
          ) : null}
          {options.map((o) => {
            const active = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent/60",
                )}
                role="option"
                aria-selected={active}
              >
                <span className="truncate">{o.label}</span>
                {active ? (
                  <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
