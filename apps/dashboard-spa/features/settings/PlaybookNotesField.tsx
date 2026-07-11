import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import type {
  FactReferenceEntryView,
  ResolvedReferencesView,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { Textarea } from "@/components/ui/textarea";

type Ctx = { readonly workspaceId: string };

// An in-progress `@token` immediately before the caret. Anchored to start-of-
// text or whitespace so it never fires inside an email address (`user@…`).
const TOKEN_AT_CARET = /(?:^|\s)@([a-z0-9_.]*)$/i;

/**
 * The in-progress `@`-token immediately before the caret, or null when there
 * isn't one (so the menu closes). `query` is the partial after `@`; `tokenStart`
 * is the index of the `@` itself, for replacing on select. Pure + exported for
 * unit testing — this is the bit that must not fire inside an email.
 */
export const matchTokenAtCaret = (
  value: string,
  caret: number,
): { readonly query: string; readonly tokenStart: number } | null => {
  const before = value.slice(0, caret);
  const m = TOKEN_AT_CARET.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { query, tokenStart: caret - query.length - 1 };
};

/**
 * The scenario "Playbook notes" editor: a controlled textarea (still form-named
 * so the existing FormData submit picks it up) with two Facts affordances:
 *
 *  - typing `@` opens a catalog-driven menu that inserts the plain token at the
 *    cursor (no rich chips — works in the plain `<textarea>`), and
 *  - a live preview below shows exactly what the agent will see once the
 *    `@`-references resolve against this store's Facts, flagging any that don't
 *    resolve (unset field or a typo) so the merchant can fix them.
 *
 * Both are driven by the same server-side catalog + resolver the runtime uses,
 * so the preview can't drift from the agent's actual prompt.
 */
export function PlaybookNotesField({
  name,
  id,
  defaultValue,
  placeholder,
  ctx,
}: {
  readonly name: string;
  readonly id: string;
  readonly defaultValue: string;
  readonly placeholder?: string;
  readonly ctx: Ctx;
}) {
  const [value, setValue] = useState(defaultValue);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tokenStart, setTokenStart] = useState(-1);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const catalogQuery = useQuery({
    queryKey: qk.factReferences(ctx.workspaceId),
    queryFn: () => api.factReferences(ctx),
    staleTime: Infinity,
  });
  const catalog = useMemo<ReadonlyArray<FactReferenceEntryView>>(
    () => catalogQuery.data ?? [],
    [catalogQuery.data],
  );

  const matches = useMemo(() => {
    if (!menuOpen) return [];
    const q = query.toLowerCase();
    return catalog
      .filter(
        (e) =>
          e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [menuOpen, query, catalog]);

  const syncMenu = (v: string, caret: number) => {
    const token = matchTokenAtCaret(v, caret);
    if (token) {
      setMenuOpen(true);
      setQuery(token.query);
      setTokenStart(token.tokenStart);
      setHighlight(0);
    } else {
      setMenuOpen(false);
    }
  };

  const insert = (entry: FactReferenceEntryView) => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const next = `${value.slice(0, tokenStart)}@${entry.id} ${value.slice(caret)}`;
    setValue(next);
    setMenuOpen(false);
    // Restore focus + place the caret just after the inserted token.
    const pos = tokenStart + entry.id.length + 2;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menuOpen || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insert(matches[highlight] ?? matches[0]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
    }
  };

  // Debounced live preview. Only resolves once the note actually carries an `@`.
  const [preview, setPreview] = useState<ResolvedReferencesView | null>(null);
  useEffect(() => {
    if (!value.includes("@")) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api.resolveFactReferences(ctx, value).then((r) => {
        if (!cancelled) setPreview(r);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // ctx is stable per workspace; resolving on value change is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Show the preview only when resolution actually changes the text or flags a
  // dangling ref — a note that merely contains an email address gets no panel.
  const showPreview =
    preview != null &&
    (preview.resolved !== value || preview.dangling.length > 0);

  return (
    <div className="relative space-y-2">
      <Textarea
        ref={taRef}
        id={id}
        name={name}
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.currentTarget.value;
          setValue(v);
          syncMenu(v, e.currentTarget.selectionStart ?? v.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Let a menu click land before closing (mousedown fires first).
          window.setTimeout(() => setMenuOpen(false), 120);
        }}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Type <span className="font-mono">@</span> to insert a store fact (return
        window, delivery time, …). It stays in sync when you update the fact.
      </p>

      {menuOpen && matches.length > 0 ? (
        <ul
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full max-w-md overflow-auto rounded-md border border-input bg-popover p-1 shadow-md"
        >
          {matches.map((entry, i) => (
            <li key={entry.id} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                // mousedown (not click) so it fires before the textarea blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(entry);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm ${
                  i === highlight ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span>{entry.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  @{entry.id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {showPreview ? (
        <div className="rounded-md border border-input bg-muted/40 p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            What the agent will read:
          </p>
          <p className="whitespace-pre-wrap text-foreground">
            {preview!.resolved}
          </p>
          {preview!.dangling.length > 0 ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                These references don&apos;t resolve yet, so a general fallback is
                used instead:{" "}
                <span className="font-mono">
                  {preview!.dangling.map((d) => `@${d}`).join(", ")}
                </span>
                . Fill in the matching fact or fix the reference.
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
