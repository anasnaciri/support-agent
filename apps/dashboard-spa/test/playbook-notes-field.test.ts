// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FactReferenceEntryView } from "@support-agent/dashboard-contracts";

import {
  buildNotesFragment,
  chipText,
  clampCaretMenuLeft,
  matchTokenAtCaret,
  PlaybookNotesField,
  serializeNotes,
} from "../features/settings/PlaybookNotesField";

// The field is a pure api client; the menu only needs the catalog. Hoisted
// because the factory runs before this module's own consts are initialized.
const { MOCK_CATALOG } = vi.hoisted(() => ({
  MOCK_CATALOG: [
    {
      id: "returns.return_window",
      namespace: "returns",
      field: "return_window",
      label: "Return window",
      value: "30 days",
    },
    {
      id: "returns.refund_processing_time",
      namespace: "returns",
      field: "refund_processing_time",
      label: "Refund processing time",
      value: "5–7 business days",
    },
  ],
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    factReferences: () => Promise.resolve(MOCK_CATALOG),
    resolveFactReferences: () =>
      Promise.resolve({ resolved: "", dangling: [] }),
  },
}));

const entry = (
  id: string,
  label: string,
  value: string | null,
): FactReferenceEntryView => {
  const [namespace, field] = id.split(".");
  return { id, namespace: namespace!, field: field ?? null, label, value };
};

const CATALOG: ReadonlyArray<FactReferenceEntryView> = [
  entry("returns.return_window", "Return window", "30 days"),
  entry(
    "returns.refund_processing_time",
    "Refund processing time",
    "5–7 business days",
  ),
  entry("shipping.delivery_time", "Delivery time", null),
];

const byId = new Map(CATALOG.map((e) => [e.id, e]));

// Render a note into a detached editor the way the field does on mount, so a
// test can assert on the chips and read the note back out.
const render = (text: string): HTMLDivElement => {
  const editor = document.createElement("div");
  editor.appendChild(buildNotesFragment(text, byId));
  return editor;
};

const chips = (editor: HTMLElement) =>
  Array.from(editor.querySelectorAll("[data-fact-ref]"));

describe("matchTokenAtCaret", () => {
  it("captures a token at the start of the text", () => {
    expect(matchTokenAtCaret("@ret", 4)).toEqual({
      query: "ret",
      tokenStart: 0,
    });
  });

  it("captures a token after whitespace and reports the @ index", () => {
    const value = "Accept within @returns.ret";
    expect(matchTokenAtCaret(value, value.length)).toEqual({
      query: "returns.ret",
      tokenStart: 14,
    });
  });

  it("fires on a bare @ so the full menu opens", () => {
    expect(matchTokenAtCaret("Reply and @", 11)).toEqual({
      query: "",
      tokenStart: 10,
    });
  });

  it("does NOT fire inside an email address", () => {
    // The `@` is preceded by a word char, not whitespace — this is an email,
    // not a reference, so the menu must stay closed.
    expect(matchTokenAtCaret("email help@store", 16)).toBeNull();
  });

  it("closes once the token is terminated by a space", () => {
    expect(matchTokenAtCaret("@returns.return_window ", 23)).toBeNull();
  });

  it("only considers text up to the caret, not after it", () => {
    const value = "@returns and more";
    // Caret sits right after "@returns".
    expect(matchTokenAtCaret(value, 8)).toEqual({
      query: "returns",
      tokenStart: 0,
    });
  });
});

describe("clampCaretMenuLeft", () => {
  it("follows the caret when the menu fits to its right", () => {
    expect(clampCaretMenuLeft(40, 320, 600)).toBe(40);
  });

  it("pulls the menu back so it never spills past the right edge", () => {
    // Caret at 500 would put the menu's right edge at 820, past the 600 box.
    expect(clampCaretMenuLeft(500, 320, 600)).toBe(280);
  });

  it("never goes negative, even in a box narrower than the menu", () => {
    expect(clampCaretMenuLeft(10, 320, 200)).toBe(0);
  });
});

describe("chipText", () => {
  it("reads as the friendly name and the store's current value", () => {
    expect(chipText(byId.get("returns.return_window")!)).toBe(
      "Return window: 30 days",
    );
  });

  it("says a fact isn't set yet rather than rendering an empty value", () => {
    expect(chipText(byId.get("shipping.delivery_time")!)).toBe(
      "Delivery time: not set",
    );
  });
});

describe("buildNotesFragment", () => {
  it("renders a catalog reference as a chip carrying its id", () => {
    const editor = render("Accept within @returns.return_window of delivery.");
    const [chip] = chips(editor);
    expect(chip?.getAttribute("data-fact-ref")).toBe("returns.return_window");
    expect(chip?.textContent).toBe("Return window: 30 days");
    // Atomic: the caret can't land inside a chip, so it deletes as one unit.
    expect(chip?.getAttribute("contenteditable")).toBe("false");
  });

  it("marks a chip whose fact isn't set yet", () => {
    const editor = render("Ships in @shipping.delivery_time.");
    expect(chips(editor)[0]?.getAttribute("data-dangling")).toBe("true");
  });

  it("leaves an email address and an unknown reference as plain text", () => {
    const editor = render("Mail help@store.com or check @shipping.nonsense.");
    expect(chips(editor)).toHaveLength(0);
    expect(editor.textContent).toBe(
      "Mail help@store.com or check @shipping.nonsense.",
    );
  });
});

describe("serializeNotes", () => {
  it("round-trips a note back to the stored @-token text", () => {
    // The TOKEN is what's stored, never the resolved value — that's what keeps
    // a note in sync when the merchant edits the fact behind it.
    const text =
      "Accept within @returns.return_window. Refunds take @returns.refund_processing_time.";
    expect(serializeNotes(render(text))).toBe(text);
  });

  it("round-trips text no chip claimed", () => {
    const text = "Mail help@store.com or check @shipping.nonsense.";
    expect(serializeNotes(render(text))).toBe(text);
  });

  it("round-trips multiple lines", () => {
    const text = "First line @returns.return_window\nSecond line";
    expect(serializeNotes(render(text))).toBe(text);
  });

  it("reads the <div>-per-line markup a browser produces on Enter", () => {
    // Chrome wraps each line typed after Enter in its own <div> and fills an
    // empty line with a bogus <br> that is markup, not content.
    const editor = document.createElement("div");
    editor.innerHTML = "first<div>second</div><div><br></div><div>third</div>";
    expect(serializeNotes(editor)).toBe("first\nsecond\n\nthird");
  });

  it("reads an empty editor as an empty note, not a stray newline", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "<br>";
    expect(serializeNotes(editor)).toBe("");
  });

  it("normalizes the non-breaking space a contenteditable inserts", () => {
    const editor = document.createElement("div");
    editor.innerHTML = "two&nbsp;words";
    expect(serializeNotes(editor)).toBe("two words");
  });
});

// ---- the live menu ----
//
// The mapping above is pure, but the menu's keyboard behaviour is not, and it is
// where the bugs live. These mount the real component and drive it with events.

// jsdom does no layout, so a Range has no geometry at all. The menu asks one
// where the caret is; give it an answer so the component can run. Nothing here
// asserts on the position — `clampCaretMenuLeft` covers that, and only a real
// browser can confirm the pixels.
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Mount the field with a note already typed, and hand back its editor. */
const mountField = async (defaultValue: string): Promise<HTMLElement> => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PlaybookNotesField, {
          name: "notes",
          id: "notes",
          defaultValue,
          ctx: { workspaceId: "w1" },
        }),
      ),
    );
  });

  const editor = container.querySelector<HTMLElement>("[contenteditable]");
  if (!editor) throw new Error("the field rendered no editor");
  return editor;
};

/**
 * Park the caret at the end of the editor's text — where a merchant who just
 * typed the token would leave it.
 *
 * Re-applied before every key because jsdom cannot focus a contenteditable, so
 * React's commit collapses the selection to the editor element on each
 * re-render. A browser keeps the caret in the text node; this restores the state
 * a browser would already be in, and never touches what the tests assert on.
 */
const caretToEnd = (editor: HTMLElement) => {
  const text = editor.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, text.data.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

const press = async (
  editor: HTMLElement,
  type: "keydown" | "keyup",
  key: string,
) => {
  caretToEnd(editor);
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
  });
};

/** aria-selected per open option, in order. */
const openOptions = () =>
  [...container!.querySelectorAll('[role="option"]')].map((li) =>
    li.getAttribute("aria-selected"),
  );

describe("the @-menu's keyboard navigation", () => {
  it("keeps the arrowed-to option selected — keyup must not snap back to the first", async () => {
    const editor = await mountField("Refund after @ret");
    caretToEnd(editor);

    // The in-progress token opens the menu on its first option.
    await press(editor, "keyup", "t");
    expect(openOptions()).toEqual(["true", "false"]);

    // Arrow down to the second...
    await press(editor, "keydown", "ArrowDown");
    expect(openOptions()).toEqual(["false", "true"]);

    // ...and RELEASING the arrow must not re-sync the menu and re-select the
    // first: the caret never moved, so there is nothing to re-sync.
    await press(editor, "keyup", "ArrowDown");
    expect(openOptions()).toEqual(["false", "true"]);
  });

  it("stays closed after Escape — keyup must not reopen it", async () => {
    const editor = await mountField("Refund after @ret");
    caretToEnd(editor);

    await press(editor, "keyup", "t");
    expect(openOptions()).toHaveLength(2);

    await press(editor, "keydown", "Escape");
    await press(editor, "keyup", "Escape");
    expect(openOptions()).toHaveLength(0);
  });
});
