import { useState } from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  /**
   * Runs the edit. Receives only the NON-EMPTY, trimmed fields. Resolves on a
   * completed request (the popover then closes) and rejects on a network/5xx
   * error (the popover stays open so the input isn't lost). The caller owns the
   * toast + query invalidation.
   */
  readonly onSubmit: (values: Record<string, string>) => Promise<void>;
  readonly title: string;
  readonly description?: string;
  readonly fields: ReadonlyArray<EditFieldConfig>;
  /** aria-label / tooltip for the pencil trigger. */
  readonly label: string;
  /** Which edge the popover panel aligns to (default: right). */
  readonly align?: "left" | "right";
  /**
   * Submit EVERY field, including blank ones (default: false — blanks are
   * dropped, "empty = no change"). Use for full-form edits where the inputs
   * are prefilled with the current values and blanking one means CLEAR it
   * (the Ship-to pencil; the api reads blank as "clear this field").
   */
  readonly submitEmpty?: boolean;
}

/**
 * A muted pencil trigger + a compact popover form for hand-correcting a ticket
 * card's fields (Customer / Order) — used when the agent couldn't extract them
 * (e.g. a legacy relay ticket stamped `mailer@shopify.com`). Self-contained: owns
 * its open + saving state, closes on outside click or after a successful save.
 * The SPA counterpart of the Next `<form action={serverAction}>` popover.
 */
export const CardEditPopover = ({
  ticketId,
  onSubmit,
  title,
  description,
  fields,
  label,
  align = "right",
  submitEmpty = false,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const values: Record<string, string> = {};
    for (const f of fields) {
      const raw = fd.get(f.name);
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      if (submitEmpty || trimmed.length > 0) values[f.name] = trimmed;
    }
    setSaving(true);
    try {
      await onSubmit(values);
      setOpen(false);
    } catch {
      /* keep the popover open so the input isn't lost; caller toasts the error */
    } finally {
      setSaving(false);
    }
  };

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
              "absolute top-8 z-40 max-h-[min(28rem,70vh)] w-72 overflow-y-auto rounded-lg border border-border bg-card p-3 text-left shadow-lg",
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
            <form onSubmit={submit} className="space-y-2.5">
              {fields.map((f, i) => (
                <div key={f.name} className="space-y-1">
                  <label
                    htmlFor={`edit-${ticketId}-${f.name}`}
                    className="text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground"
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
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
};
