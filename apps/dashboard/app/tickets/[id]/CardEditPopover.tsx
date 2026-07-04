"use client";

import * as React from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";

export interface EditFieldConfig {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly autoComplete?: string;
}

interface Props {
  readonly ticketId: string;
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly title: string;
  readonly description?: string;
  readonly fields: ReadonlyArray<EditFieldConfig>;
  /** aria-label / tooltip for the pencil trigger. */
  readonly label: string;
  /** Which edge the popover panel aligns to (default: right). */
  readonly align?: "left" | "right";
}

/**
 * A muted pencil trigger + a compact popover form for hand-correcting a ticket
 * card's fields (Customer / Order) — used when the agent couldn't extract them
 * (e.g. a legacy relay ticket stamped `mailer@shopify.com`). Self-contained: owns
 * its open state and closes on outside click or after the server action
 * redirects. Sleek by design — a small ghost pencil, minimal labelled inputs,
 * no boxy chrome until you open it.
 */
export const CardEditPopover = ({
  ticketId,
  action,
  title,
  description,
  fields,
  label,
  align = "right",
}: Props) => {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>

      {open ? (
        <>
          {/* Click-away layer — below the panel, above the page. */}
          <div
            aria-hidden
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
          />
          <div
            className={cn(
              "absolute top-8 z-40 w-72 rounded-lg border border-border bg-card p-3 text-left shadow-lg",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <div className="mb-2">
              <div className="text-sm font-medium normal-case tracking-normal">
                {title}
              </div>
              {description ? (
                <p className="mt-0.5 text-xs font-normal normal-case tracking-normal text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <form action={action} className="space-y-2.5">
              <input type="hidden" name="ticketId" value={ticketId} />
              {fields.map((f, i) => (
                <div key={f.name} className="space-y-1">
                  <label
                    htmlFor={`edit-${ticketId}-${f.name}`}
                    className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {f.label}
                  </label>
                  <Input
                    id={`edit-${ticketId}-${f.name}`}
                    name={f.name}
                    type={f.type ?? "text"}
                    defaultValue={f.defaultValue}
                    placeholder={f.placeholder}
                    autoComplete={f.autoComplete ?? "off"}
                    autoFocus={i === 0}
                    className="h-8"
                  />
                </div>
              ))}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <SubmitButton size="sm" pendingLabel="Saving…">
                  Save
                </SubmitButton>
              </div>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
};
