"use client";

import { Check, ChevronsUpDown, Search } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly contextLength?: number;
}

export interface ModelComboboxProps {
  /** Hidden field name. The picker writes the selected id into a hidden
   *  <input> so a plain <form> submit ships the value through. */
  readonly name: string;
  /** Currently selected model id. Empty string means "use default". */
  readonly value: string;
  /** Full model list grouped by family at render time. */
  readonly options: ReadonlyArray<ModelOption>;
  /** Default model from the agent config — rendered as a sentinel row at
   *  the top of the list ("Reset to default — <model>"). */
  readonly defaultModel: string;
  /** Disables the trigger; used when no provider is connected. */
  readonly disabled?: boolean;
  /** Optional placeholder when nothing is selected. */
  readonly placeholder?: string;
}

interface Group {
  readonly family: string;
  readonly options: ReadonlyArray<ModelOption>;
}

const groupByFamily = (
  options: ReadonlyArray<ModelOption>,
): ReadonlyArray<Group> => {
  const byFamily = new Map<string, ModelOption[]>();
  for (const o of options) {
    const arr = byFamily.get(o.family) ?? [];
    arr.push(o);
    byFamily.set(o.family, arr);
  }
  return Array.from(byFamily.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, opts]) => ({ family, options: opts }));
};

const matches = (q: string, o: ModelOption): boolean => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    o.id.toLowerCase().includes(needle) ||
    o.name.toLowerCase().includes(needle) ||
    o.family.toLowerCase().includes(needle)
  );
};

const formatContext = (n?: number): string | null => {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M ctx`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K ctx`;
  return `${n} ctx`;
};

export const ModelCombobox = ({
  name,
  value,
  options,
  defaultModel,
  disabled,
  placeholder,
}: ModelComboboxProps) => {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // value === "" means "use default" — we surface it as the sentinel
  // option so the user can revert from a custom pick back to default.
  const [selected, setSelected] = React.useState(value);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      // Wait a microtask so the input is mounted before focusing.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  const filtered = React.useMemo(
    () => options.filter((o) => matches(query, o)),
    [options, query],
  );
  const groups = React.useMemo(() => groupByFamily(filtered), [filtered]);

  const selectedOption = React.useMemo(
    () => options.find((o) => o.id === selected),
    [options, selected],
  );

  const displayLabel = (() => {
    if (!selected) return `Default (${defaultModel})`;
    if (selectedOption) return selectedOption.name;
    // Selected id isn't in the current catalog (provider switched?).
    return selected;
  })();

  const pick = (id: string) => {
    setSelected(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={selected} />
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <span className="truncate text-left">
          {selected ? (
            <>
              <span className="font-medium">{displayLabel}</span>
              {selectedOption && selectedOption.id !== selectedOption.name ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {selectedOption.id}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">
              {placeholder ?? `Default (${defaultModel})`}
            </span>
          )}
        </span>
        <ChevronsUpDown
          className="ml-2 size-3.5 shrink-0 opacity-50"
          aria-hidden
        />
      </button>

      {open ? (
        <div
          ref={listRef}
          className="absolute left-0 right-0 z-50 mt-1 max-h-[360px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {/* Sentinel "use default" row, always rendered when search matches. */}
            {matches(query, {
              id: "default",
              name: `Default (${defaultModel})`,
              family: "Default",
            }) ? (
              <button
                type="button"
                onClick={() => pick("")}
                className={cn(
                  "flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                  selected === "" && "bg-accent/60",
                )}
                role="option"
                aria-selected={selected === ""}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    Default (agent config)
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {defaultModel}
                  </div>
                </div>
                {selected === "" ? (
                  <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                ) : null}
              </button>
            ) : null}

            {groups.length === 0 && query ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No models matched &ldquo;{query}&rdquo;.
              </div>
            ) : null}

            {groups.map((g) => (
              <div key={g.family} className="py-1">
                <div className="px-3 pb-1 pt-2 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  {g.family}
                </div>
                {g.options.map((o) => {
                  const ctx = formatContext(o.contextLength);
                  const active = o.id === selected;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => pick(o.id)}
                      className={cn(
                        "flex w-full items-start justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                        active && "bg-accent/60",
                      )}
                      role="option"
                      aria-selected={active}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{o.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {o.id}
                          {ctx ? <span className="ml-2">{ctx}</span> : null}
                        </div>
                      </div>
                      {active ? (
                        <Check
                          className="size-3.5 shrink-0 text-primary"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
