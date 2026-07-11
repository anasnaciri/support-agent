import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import type { FactReferenceEntryView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type Ctx = { readonly workspaceId: string };
type Catalog = ReadonlyMap<string, FactReferenceEntryView>;

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

const MENU_WIDTH = 320;

/**
 * Where to put the menu's left edge so it opens at the caret without spilling
 * past the field's right edge. Pure + exported for unit testing.
 */
export const clampCaretMenuLeft = (
  caretLeft: number,
  menuWidth: number,
  boxWidth: number,
): number => Math.max(0, Math.min(caretLeft, boxWidth - menuWidth));

// ---- the note ↔ DOM mapping ----
//
// The note is STORED as `@id` tokens and only ever rendered as chips, so editing
// a fact updates every note that references it. Two pure functions own that
// mapping: `buildNotesFragment` (token text → chips) and `serializeNotes` (the
// live editor → token text). They are inverses, and their round-trip is tested.

// Mirrors the resolver's grammar in packages/services/src/fact-references.ts:
// `@ns` or `@ns.field`. Anything else — an email, an unknown id — is left as
// plain text and never becomes a chip.
const TOKEN = /@([a-z][a-z0-9_]*)(?:\.([a-z][a-z0-9_]*))?/gi;

/** What a chip reads as: the fact's friendly name and this store's value. */
export const chipText = (entry: FactReferenceEntryView): string =>
  `${entry.label}: ${entry.value ?? "not set"}`;

const CHIP_CLASS =
  "mx-0.5 inline-flex select-none items-center rounded-md px-1.5 py-0.5 align-baseline text-xs font-medium ring-1 " +
  "bg-primary/10 text-primary ring-primary/20 " +
  // A fact the merchant hasn't filled in: the agent falls back to a vague
  // phrase, so the chip has to look like it needs attention.
  "data-[dangling=true]:bg-amber-500/10 data-[dangling=true]:text-amber-700 data-[dangling=true]:ring-amber-500/30 " +
  "dark:data-[dangling=true]:text-amber-500";

const createChip = (entry: FactReferenceEntryView): HTMLSpanElement => {
  const chip = document.createElement("span");
  chip.setAttribute("data-fact-ref", entry.id);
  // Atomic: the caret can't land inside it, and backspace removes the whole ref.
  chip.setAttribute("contenteditable", "false");
  chip.className = CHIP_CLASS;
  if (entry.value == null) chip.setAttribute("data-dangling", "true");
  chip.textContent = chipText(entry);
  return chip;
};

/** Render stored note text into editor nodes, catalog references as chips. */
export const buildNotesFragment = (
  text: string,
  catalog: Catalog,
): DocumentFragment => {
  const frag = document.createDocumentFragment();
  text.split("\n").forEach((line, lineIndex) => {
    if (lineIndex > 0) frag.appendChild(document.createElement("br"));
    let cursor = 0;
    for (const m of line.matchAll(TOKEN)) {
      const id = (m[2] ? `${m[1]}.${m[2]}` : m[1]!).toLowerCase();
      const entry = catalog.get(id);
      if (!entry) continue; // an email or an unknown id — leave it as text
      const at = m.index;
      if (at > cursor) {
        frag.appendChild(document.createTextNode(line.slice(cursor, at)));
      }
      frag.appendChild(createChip(entry));
      cursor = at + m[0].length;
    }
    if (cursor < line.length) {
      frag.appendChild(document.createTextNode(line.slice(cursor)));
    }
  });
  return frag;
};

const isBlock = (el: Element) =>
  el.tagName === "DIV" || el.tagName === "P" || el.tagName === "LI";

/** Read the live editor back out as the note text to store. */
export const serializeNotes = (root: HTMLElement): string => {
  const out: string[] = [];

  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        // A contenteditable pads with non-breaking spaces; they are ordinary
        // spaces as far as the note (and the agent) are concerned.
        out.push((child as Text).data.replace(/\u00a0/g, " "));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;

      const ref = el.getAttribute("data-fact-ref");
      if (ref) {
        out.push(`@${ref}`);
        continue;
      }
      if (el.tagName === "BR") {
        out.push("\n");
        continue;
      }
      if (isBlock(el)) {
        // A browser wraps each line typed after Enter in its own block, and
        // fills an empty one with a bogus <br> that is markup, not content.
        out.push("\n");
        const onlyChild = el.childNodes.length === 1 ? el.firstChild : null;
        if (!onlyChild || onlyChild.nodeName !== "BR") visit(el);
        continue;
      }
      visit(el);
    }
  };
  visit(root);

  let text = out.join("");
  // A leading block is the first line, not a line break after an empty one.
  const first = root.firstChild;
  if (first?.nodeType === Node.ELEMENT_NODE && isBlock(first as Element)) {
    text = text.replace(/^\n/, "");
  }
  // The trailing <br> a browser parks at the end of an editable is markup too.
  return text.replace(/\n+$/, "");
};

// ---- the field ----

const EDITOR_CLASS =
  "min-h-[120px] w-full whitespace-pre-wrap break-words rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

/**
 * The scenario "Playbook notes" editor. The merchant writes prose; a reference
 * to a store Fact is rendered inline as a `Return window: 30 days` chip, so the
 * note reads as the agent will read it without the merchant having to hold the
 * `@returns.return_window` spelling in their head.
 *
 * What is stored is still the plain `@id` token (see `serializeNotes`) — resolve
 * on render, never resolve-and-store, so editing a fact updates every note that
 * references it. Chips, the `@` menu, and the dangling warning are all driven by
 * the same server catalog + resolver the agent runtime uses, so what the
 * merchant sees can't drift from the agent's prompt.
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
  const [highlight, setHighlight] = useState(0);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Chips can only be rendered once the catalog (labels + this store's values)
  // has arrived. Until then the editor shows the raw note, and it is re-rendered
  // exactly once — never under a caret the merchant is already using.
  const chippedRef = useRef(false);
  const dirtyRef = useRef(false);

  const catalogQuery = useQuery({
    queryKey: qk.factReferences(ctx.workspaceId),
    queryFn: () => api.factReferences(ctx),
    staleTime: Infinity,
  });
  const catalog = useMemo<Catalog>(
    () => new Map((catalogQuery.data ?? []).map((e) => [e.id, e])),
    [catalogQuery.data],
  );

  // Paint the note on mount (plain, so it is never invisible while the catalog
  // loads), then upgrade its references to chips as soon as the catalog lands.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (chippedRef.current || dirtyRef.current) return;
    if (el.childNodes.length > 0 && catalog.size === 0) return;
    el.replaceChildren(buildNotesFragment(value, catalog));
    if (catalog.size > 0) chippedRef.current = true;
    // `value` is intentionally not a dep: after mount the DOM is the source of
    // truth for what's displayed, and re-rendering it would drop the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const matches = useMemo(() => {
    if (!menuOpen) return [];
    const q = query.toLowerCase();
    return [...catalog.values()]
      .filter(
        (e) =>
          e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [menuOpen, query, catalog]);

  /** The caret's text node + offset, when the caret is inside this editor. */
  const caretInText = (): { node: Text; offset: number } | null => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
    return { node: node as Text, offset: range.startOffset };
  };

  // Open the menu on an in-progress `@token`, anchored at the caret. A token
  // can't span a chip, so the caret's own text node is the whole search space.
  const syncMenu = () => {
    const el = editorRef.current;
    const caret = caretInText();
    if (!el || !caret) {
      setMenuOpen(false);
      return;
    }
    const token = matchTokenAtCaret(caret.node.data, caret.offset);
    if (!token) {
      setMenuOpen(false);
      return;
    }
    setMenuOpen(true);
    setQuery(token.query);
    setHighlight(0);

    // Unlike a <textarea>, a contenteditable exposes the caret's real geometry.
    const marker = document.createRange();
    marker.setStart(caret.node, token.tokenStart);
    marker.collapse(true);
    const rect = marker.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    setMenuPos({
      left: clampCaretMenuLeft(rect.left - box.left, MENU_WIDTH, el.clientWidth),
      top: Math.min(rect.bottom - box.top + 4, el.clientHeight),
    });
  };

  const commit = () => {
    const el = editorRef.current;
    if (!el) return;
    dirtyRef.current = true;
    setValue(serializeNotes(el));
  };

  // Swap the typed `@token` for its chip, in place.
  const insert = (entry: FactReferenceEntryView) => {
    const el = editorRef.current;
    const caret = caretInText();
    if (!el || !caret) return;
    const token = matchTokenAtCaret(caret.node.data, caret.offset);
    if (!token) return;

    const range = document.createRange();
    range.setStart(caret.node, token.tokenStart);
    range.setEnd(caret.node, caret.offset);
    range.deleteContents();

    // A trailing space gives the caret somewhere to live after the chip — a
    // contenteditable has no reliable position after a trailing atomic node.
    const trailing = document.createTextNode(" ");
    range.insertNode(trailing);
    range.insertNode(createChip(entry));

    const after = document.createRange();
    after.setStart(trailing, trailing.length);
    after.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);

    setMenuOpen(false);
    el.focus();
    commit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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

  // The dangling-ref warning: resolved server-side by the same resolver the
  // runtime uses, so it also catches a mistyped id a chip never claimed.
  const [dangling, setDangling] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    if (!value.includes("@")) {
      setDangling([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api.resolveFactReferences(ctx, value).then((r) => {
        if (!cancelled) setDangling(r.dangling);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // ctx is stable per workspace; re-resolving on value change is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <div
          ref={editorRef}
          id={id}
          role="textbox"
          aria-multiline="true"
          aria-describedby={`${id}-hint`}
          contentEditable
          suppressContentEditableWarning
          className={EDITOR_CLASS}
          onInput={() => {
            commit();
            syncMenu();
          }}
          onKeyUp={syncMenu}
          onMouseUp={syncMenu}
          onKeyDown={onKeyDown}
          // Chips are ours to render — never let a paste bring its own markup in.
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
          }}
          onBlur={() => {
            // Let a menu click land before closing (mousedown fires first).
            window.setTimeout(() => setMenuOpen(false), 120);
          }}
        />
        {value === "" && placeholder ? (
          <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">
            {placeholder}
          </span>
        ) : null}

        {menuOpen && matches.length > 0 ? (
          <ul
            role="listbox"
            // Opens at the caret, not under the whole field.
            style={{ left: menuPos.left, top: menuPos.top, width: MENU_WIDTH }}
            className="absolute z-20 max-h-64 overflow-auto rounded-md border border-input bg-popover p-1 shadow-md"
          >
            {matches.map((entry, i) => (
              <li key={entry.id} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  // mousedown (not click) so it fires before the editor blurs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insert(entry);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm",
                    i === highlight && "bg-accent text-accent-foreground",
                  )}
                >
                  <span>{entry.label}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {entry.value ?? "not set"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* contenteditable is not a form control — this is what the form submits. */}
      <input type="hidden" name={name} value={value} />

      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Type <span className="font-mono">@</span> to insert a store fact (return
        window, delivery time, …). It stays in sync when you update the fact.
      </p>

      {dangling.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            These references don&apos;t resolve yet, so your agent falls back to
            a vague phrase:{" "}
            <span className="font-mono">
              {dangling.map((d) => `@${d}`).join(", ")}
            </span>
            . Fill in the matching fact or fix the reference.
          </span>
        </p>
      ) : null}
    </div>
  );
}
