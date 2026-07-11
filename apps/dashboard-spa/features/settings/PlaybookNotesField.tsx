import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Database, FileText, Zap } from "lucide-react";

import { toolDisplayName } from "@support-agent/agent-core";
import type { FactReferenceEntryView } from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type Ctx = { readonly workspaceId: string };
type Catalog = ReadonlyMap<string, FactReferenceEntryView>;

/** `@` references a source of truth (a fact, a doc); `/` references an action. */
export type ReferenceSigil = "@" | "/";

export type ReferenceKind = "fact" | "doc" | "action";

export const referenceSourceKind = (
  entry: FactReferenceEntryView,
): ReferenceKind =>
  entry.namespace === "docs"
    ? "doc"
    : entry.namespace === "actions"
      ? "action"
      : "fact";

const sigilFor = (entry: FactReferenceEntryView): ReferenceSigil =>
  referenceSourceKind(entry) === "action" ? "/" : "@";

/**
 * The catalog entry a token names — but ONLY when the sigil agrees with the
 * entry's kind. `@refund.create` is not an action and `/returns.return_window`
 * is not a fact: the sigil is what tells a source of truth from an action, and
 * neither may quietly claim the other's tokens.
 */
const entryForToken = (
  catalog: Catalog,
  sigil: ReferenceSigil,
  id: string,
): FactReferenceEntryView | null => {
  const entry = catalog.get(id);
  return entry && sigilFor(entry) === sigil ? entry : null;
};

// An in-progress `@token` / `/token` immediately before the caret. Anchored to
// start-of-text or whitespace so it never fires inside an email address
// (`user@…`), a url path (`shop.example/refund`), or a date (`24/7`).
const TOKEN_AT_CARET = /(?:^|\s)([@/])([a-z0-9_.-]*)$/i;

/**
 * The in-progress token immediately before the caret, or null when there isn't
 * one (so the menu closes). `sigil` says which menu opens; `query` is the partial
 * after it; `tokenStart` is the index of the sigil itself, for replacing on
 * select. Pure + exported for unit testing — this is the bit that must not fire
 * inside an email or a url.
 */
export const matchTokenAtCaret = (
  value: string,
  caret: number,
): {
  readonly sigil: ReferenceSigil;
  readonly query: string;
  readonly tokenStart: number;
} | null => {
  const before = value.slice(0, caret);
  const m = TOKEN_AT_CARET.exec(before);
  if (!m) return null;
  const sigil = m[1] as ReferenceSigil;
  const query = m[2] ?? "";
  return { sigil, query, tokenStart: caret - query.length - 1 };
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

export const scrollReferenceMenuToHighlight = (
  menu: HTMLElement,
  highlighted: HTMLElement,
) => {
  const row = highlighted.closest<HTMLElement>('[role="option"]') ?? highlighted;
  const rowTop = row.offsetTop;
  const rowBottom = rowTop + row.offsetHeight;
  const visibleTop = menu.scrollTop;
  const visibleBottom = visibleTop + menu.clientHeight;

  if (rowBottom > visibleBottom) {
    menu.scrollTo({
      top: rowBottom - menu.clientHeight,
      behavior: "smooth",
    });
    return;
  }

  if (rowTop < visibleTop) {
    menu.scrollTo({ top: rowTop, behavior: "smooth" });
  }
};

// ---- the note ↔ DOM mapping ----
//
// The note is STORED as `@id` / `/id` tokens and only ever rendered as chips, so
// editing a fact updates every note that references it — and a tool id never has
// to be shown to a merchant. Two pure functions own that mapping:
// `buildNotesFragment` (token text → chips) and `serializeNotes` (the live editor
// → token text). They are inverses, and their round-trip is tested.

// Mirrors the resolver's grammar in packages/services/src/fact-references.ts:
// `@ns` / `@ns.field` for a fact or doc, `/ns.tool` for an action. Fact fields are
// lowercase identifiers; doc refs use `@docs.<uuid>`, so the field side also
// accepts digits and hyphens. Anything else — an email, a url path, an unknown
// id — is left as plain text and never becomes a chip.
const TOKEN = /([@/])([a-z][a-z0-9_]*)(?:\.([a-z0-9][a-z0-9_-]*))?/gi;

// A `/` only opens a reference at a word boundary; mid-word it is a path or a
// date. (`@` needs no such rule: an email's domain is never a catalog id.)
const opensAction = (line: string, at: number): boolean =>
  at === 0 || /[\s([]/.test(line[at - 1]!);

/**
 * What a chip reads as: a fact or doc shows its friendly name and this store's
 * current value; an action shows only its name — an action has no per-tenant
 * value, and the tool id behind it is not the merchant's vocabulary.
 */
export const chipText = (entry: FactReferenceEntryView): string =>
  referenceSourceKind(entry) === "action"
    ? entry.label
    : `${entry.label}: ${entry.value ?? "not set"}`;

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
  chip.setAttribute("data-ref-sigil", sigilFor(entry));
  // Atomic: the caret can't land inside it, and backspace removes the whole ref.
  chip.setAttribute("contenteditable", "false");
  chip.className = CHIP_CLASS;
  // Only a source of truth can dangle — an action has no value to be missing.
  if (referenceSourceKind(entry) !== "action" && entry.value == null) {
    chip.setAttribute("data-dangling", "true");
  }
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
      const at = m.index;
      const sigil = m[1] as ReferenceSigil;
      if (sigil === "/" && !opensAction(line, at)) continue;
      const id = (m[3] ? `${m[2]}.${m[3]}` : m[2]!).toLowerCase();
      const entry = entryForToken(catalog, sigil, id);
      if (!entry) continue; // an email, a url, an unknown id — leave it as text
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

/**
 * The actions a note tells the agent to take, in order, without repeats. Pure +
 * exported: this is what the turned-off-action warning is computed from, and it
 * must agree with `buildNotesFragment` on what counts as an action ref (a `/` at
 * a word boundary — never a url path or a date).
 */
export const referencedActionIds = (text: string): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(TOKEN)) {
      if (m[1] !== "/" || !m[3]) continue;
      if (!opensAction(line, m.index)) continue;
      ids.add(`${m[2]}.${m[3]}`.toLowerCase());
    }
  }
  return [...ids];
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
        out.push(`${el.getAttribute("data-ref-sigil") ?? "@"}${ref}`);
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
 * The scenario "Playbook notes" editor. The merchant writes prose; references
 * render inline as chips, so the note reads close to the agent-visible
 * instruction without the merchant having to hold token spellings like
 * `@returns.return_window` in their head. Two sigils, two kinds of reference:
 *
 *   - `@` — a source of truth: a store Fact or a knowledge doc. The chip shows
 *     this store's current value, and an unset one is flagged.
 *   - `/` — an ACTION the agent can take. The chip shows only the merchant-facing
 *     name ("Issue a refund"); the tool id it stores (`refund.create`) is what the
 *     model needs to call the right tool, and is never shown here.
 *
 * What is stored is the plain token (see `serializeNotes`) — resolve on render,
 * never resolve-and-store, so editing a source updates every note that references
 * it, and renaming an action in one place renames it everywhere. Chips, both
 * menus, and the dangling warning are driven by the same server catalog +
 * resolver the agent runtime uses, so what the merchant sees can't drift from
 * the agent's prompt.
 */
export function PlaybookNotesField({
  name,
  id,
  defaultValue,
  placeholder,
  ctx,
  deniedActions,
}: {
  readonly name: string;
  readonly id: string;
  readonly defaultValue: string;
  readonly placeholder?: string;
  readonly ctx: Ctx;
  /**
   * Actions this scenario's switches forbid (see `deniedActionsFor`). A note that
   * references one is telling the agent to do something the runtime will refuse —
   * the merchant is warned, live, as they toggle the switches above.
   */
  readonly deniedActions?: ReadonlySet<string>;
}) {
  const [value, setValue] = useState(defaultValue);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sigil, setSigil] = useState<ReferenceSigil>("@");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const editorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  // Chips can only be rendered once the catalog (labels + this store's values)
  // has arrived. Until then the editor shows the raw note, and it is re-rendered
  // exactly once — never under a caret the merchant is already using.
  const chippedRef = useRef(false);
  const dirtyRef = useRef(false);
  // Set when an open menu handles a keydown itself (arrows, Enter, Escape). The
  // matching keyup must then NOT re-sync the menu: the caret never moved, so a
  // sync has nothing to learn and would only undo what the key just did — reset
  // the arrowed-to highlight, or reopen the menu Escape just closed.
  const menuHandledKeyRef = useRef(false);

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

  // One editor, two menus: `@` offers the sources of truth, `/` the actions.
  const matches = useMemo(() => {
    if (!menuOpen) return [];
    const q = query.toLowerCase();
    return [...catalog.values()]
      .filter((e) => sigilFor(e) === sigil)
      .filter(
        (e) =>
          e.id.toLowerCase().includes(q) ||
          e.label.toLowerCase().includes(q) ||
          (e.value?.toLowerCase().includes(q) ?? false),
      );
  }, [menuOpen, sigil, query, catalog]);

  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const highlighted = menu?.querySelector<HTMLElement>(
      '[data-highlighted="true"]',
    );
    if (!menu || !highlighted) return;
    scrollReferenceMenuToHighlight(menu, highlighted);
  }, [highlight, matches.length, menuOpen]);

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
    setSigil(token.sigil);
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
    } else {
      return;
    }
    menuHandledKeyRef.current = true;
  };

  const onKeyUp = () => {
    if (menuHandledKeyRef.current) {
      menuHandledKeyRef.current = false;
      return;
    }
    syncMenu();
  };

  // The turned-off-action warning. Local and instant (no round-trip): both halves
  // — the note and the scenario's switches — are already on this screen, and the
  // merchant needs to see the contradiction the moment they create it.
  const blockedActions = useMemo(() => {
    if (!deniedActions || deniedActions.size === 0) return [];
    return referencedActionIds(value)
      .filter((id) => deniedActions.has(id))
      .map((id) => catalog.get(id)?.label ?? toolDisplayName(id));
  }, [value, deniedActions, catalog]);

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
          onKeyUp={onKeyUp}
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
            ref={menuRef}
            role="listbox"
            // Opens at the caret, not under the whole field.
            style={{ left: menuPos.left, top: menuPos.top, width: MENU_WIDTH }}
            className="absolute z-20 max-h-64 overflow-auto rounded-md border border-input bg-popover p-1 shadow-md"
          >
            {matches.map((entry, i) => {
              const kind = referenceSourceKind(entry);
              const Icon =
                kind === "doc" ? FileText : kind === "action" ? Zap : Database;
              return (
                <li
                  key={entry.id}
                  role="option"
                  aria-selected={i === highlight}
                >
                  <button
                    type="button"
                    data-reference-kind={kind}
                    data-highlighted={i === highlight ? "true" : undefined}
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
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Icon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="truncate">{entry.label}</span>
                    </span>
                    {/* An action has no value, and its tool id is not the
                        merchant's vocabulary — the name is the whole row. */}
                    {kind === "action" ? null : (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {entry.value ?? "not set"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* contenteditable is not a form control — this is what the form submits. */}
      <input type="hidden" name={name} value={value} />

      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Type <span className="font-mono">@</span> to insert a store fact or
        knowledge doc, or <span className="font-mono">/</span> to reference an
        action.
      </p>

      {blockedActions.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">{blockedActions.join(", ")}</span>{" "}
            {blockedActions.length > 1 ? "are" : "is"} turned off for this
            scenario, but the playbook still asks for{" "}
            {blockedActions.length > 1 ? "them" : "it"}, so your agent won&apos;t
            do {blockedActions.length > 1 ? "them" : "it"}. Turn{" "}
            {blockedActions.length > 1 ? "them" : "it"} on above, or take{" "}
            {blockedActions.length > 1 ? "them" : "it"} out of the playbook.
          </span>
        </p>
      ) : null}

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
