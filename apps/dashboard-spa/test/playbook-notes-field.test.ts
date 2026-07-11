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
  referencedActionIds,
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
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `shipping.extra_${index}`,
      namespace: "shipping",
      field: `extra_${index}`,
      label: `Shipping fact ${index}`,
      value: `shipping value ${index}`,
    })),
    {
      id: "docs.123e4567-e89b-12d3-a456-426614174000",
      namespace: "docs",
      field: "123e4567-e89b-12d3-a456-426614174000",
      label: "Knowledge doc",
      value: "International shipping policy",
    },
    {
      id: "refund.create",
      namespace: "actions",
      field: null,
      label: "Issue a refund",
      value: null,
    },
    {
      id: "conversation.ask_customer",
      namespace: "actions",
      field: null,
      label: "Ask the customer a question",
      value: null,
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

/** An action entry: the tool id, its merchant-facing name, and no value. */
const action = (id: string, label: string): FactReferenceEntryView => ({
  id,
  namespace: "actions",
  field: null,
  label,
  value: null,
});

const CATALOG: ReadonlyArray<FactReferenceEntryView> = [
  entry("returns.return_window", "Return window", "30 days"),
  entry(
    "returns.refund_processing_time",
    "Refund processing time",
    "5–7 business days",
  ),
  entry("shipping.delivery_time", "Delivery time", null),
  entry(
    "docs.123e4567-e89b-12d3-a456-426614174000",
    "Knowledge doc",
    "International shipping policy",
  ),
  action("refund.create", "Issue a refund"),
  action("conversation.ask_customer", "Ask the customer a question"),
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
      sigil: "@",
      query: "ret",
      tokenStart: 0,
    });
  });

  it("captures a token after whitespace and reports the @ index", () => {
    const value = "Accept within @returns.ret";
    expect(matchTokenAtCaret(value, value.length)).toEqual({
      sigil: "@",
      query: "returns.ret",
      tokenStart: 14,
    });
  });

  it("fires on a bare @ so the full menu opens", () => {
    expect(matchTokenAtCaret("Reply and @", 11)).toEqual({
      sigil: "@",
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

  it("keeps hyphenated doc ids in the in-progress token", () => {
    const value = "See @docs.123e4567-e89b";
    expect(matchTokenAtCaret(value, value.length)).toEqual({
      sigil: "@",
      query: "docs.123e4567-e89b",
      tokenStart: 4,
    });
  });

  it("only considers text up to the caret, not after it", () => {
    const value = "@returns and more";
    // Caret sits right after "@returns".
    expect(matchTokenAtCaret(value, 8)).toEqual({
      sigil: "@",
      query: "returns",
      tokenStart: 0,
    });
  });

  it("opens the action menu on a bare `/`", () => {
    expect(matchTokenAtCaret("Then /", 6)).toEqual({
      sigil: "/",
      query: "",
      tokenStart: 5,
    });
  });

  it("captures an in-progress action token", () => {
    const value = "Queue /refund.cr";
    expect(matchTokenAtCaret(value, value.length)).toEqual({
      sigil: "/",
      query: "refund.cr",
      tokenStart: 6,
    });
  });

  it("does NOT fire inside a url path or a date", () => {
    // The `/` is preceded by a word char — a path or "24/7", not a reference.
    expect(matchTokenAtCaret("see https://shop.example/ref", 28)).toBeNull();
    expect(matchTokenAtCaret("we reply 24/7", 13)).toBeNull();
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

  it("reads an action as just its name — a merchant never sees the tool id", () => {
    expect(chipText(byId.get("refund.create")!)).toBe("Issue a refund");
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

  it("renders a knowledge doc reference as a chip carrying the document id", () => {
    const editor = render(
      "Follow @docs.123e4567-e89b-12d3-a456-426614174000 for international orders.",
    );
    const [chip] = chips(editor);
    expect(chip?.getAttribute("data-fact-ref")).toBe(
      "docs.123e4567-e89b-12d3-a456-426614174000",
    );
    expect(chip?.textContent).toBe(
      "Knowledge doc: International shipping policy",
    );
  });

  it("renders a `/` action reference as a chip carrying the tool id", () => {
    const editor = render("When it is due, queue /refund.create.");
    const [chip] = chips(editor);
    expect(chip?.getAttribute("data-fact-ref")).toBe("refund.create");
    expect(chip?.getAttribute("data-ref-sigil")).toBe("/");
    expect(chip?.textContent).toBe("Issue a refund");
    // An action has no tenant value, so it can never be "not set".
    expect(chip?.getAttribute("data-dangling")).toBeNull();
  });

  it("leaves a url path and a date as plain text", () => {
    const text = "See https://shop.example/refund.create — we reply 24/7.";
    const editor = render(text);
    expect(chips(editor)).toHaveLength(0);
    expect(editor.textContent).toBe(text);
  });

  it("never lets one sigil claim the other's reference", () => {
    // `@refund.create` is not an action and `/returns.return_window` is not a
    // fact — the sigil is what tells them apart, for the merchant and the agent.
    const editor = render("@refund.create and /returns.return_window");
    expect(chips(editor)).toHaveLength(0);
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

  it("round-trips an action chip back to its `/` token", () => {
    const text = "Ask with /conversation.ask_customer, then queue /refund.create.";
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

describe("referencedActionIds", () => {
  it("lists the actions a playbook tells the agent to take", () => {
    expect(
      referencedActionIds(
        "Ask with /conversation.ask_customer, then queue /refund.create.",
      ),
    ).toEqual(["conversation.ask_customer", "refund.create"]);
  });

  it("ignores fact refs, url paths, and dates", () => {
    expect(
      referencedActionIds(
        "Within @returns.return_window — see https://shop.example/refund.create, we reply 24/7.",
      ),
    ).toEqual([]);
  });

  it("reports each action once, however often the note names it", () => {
    expect(
      referencedActionIds("/refund.create now, or /refund.create later."),
    ).toEqual(["refund.create"]);
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
HTMLElement.prototype.scrollIntoView ??= () => undefined;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** Mount the field with a note already typed, and hand back its editor. */
const mountField = async (
  defaultValue: string,
  deniedActions?: ReadonlySet<string>,
): Promise<HTMLElement> => {
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
          ...(deniedActions ? { deniedActions } : {}),
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

describe("the turned-off-action warning", () => {
  it("warns when the playbook tells the agent to take an action the scenario denies", async () => {
    // The soft layer contradicting the hard gate: the note says to refund, the
    // scenario's switches say it may not. The runtime silently removes the tool,
    // so the merchant has to be told here — named the way they named it.
    await mountField(
      "When it is genuinely lost, queue /refund.create.",
      new Set(["refund.create"]),
    );
    const warning = [...container!.querySelectorAll("p")]
      .map((p) => p.textContent ?? "")
      .find((t) => t.toLowerCase().includes("turned off"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Issue a refund");
    // Named the merchant's way — never the tool id.
    expect(warning).not.toContain("refund.create");
  });

  it("says nothing when every referenced action is enabled", async () => {
    await mountField(
      "When it is genuinely lost, queue /refund.create.",
      new Set(["discount.create"]),
    );
    expect(container!.textContent ?? "").not.toContain("turned off");
  });

  it("says nothing about a baseline action, which is always on", async () => {
    await mountField(
      "Ask with /conversation.ask_customer first.",
      new Set(["refund.create", "discount.create"]),
    );
    expect(container!.textContent ?? "").not.toContain("turned off");
  });
});

describe("the @-menu's keyboard navigation", () => {
  it("marks fact and doc options with distinct source kinds", async () => {
    const editor = await mountField("Use @");
    caretToEnd(editor);

    await press(editor, "keyup", "@");

    const kinds = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        "[data-reference-kind]",
      ),
    ].map((button) => button.dataset.referenceKind);
    expect(kinds).toContain("fact");
    expect(kinds).toContain("doc");
    // Actions live under `/`, so they must not crowd the `@` menu.
    expect(kinds).not.toContain("action");
  });

  it("offers only actions under `/`, named the way the merchant reads them", async () => {
    // Two sigils, two catalogs. The merchant asking for a fact must not have to
    // scroll past every action the agent can take, and vice versa.
    const slash = await mountField("Then /");
    caretToEnd(slash);
    await press(slash, "keyup", "/");
    const slashKinds = [
      ...container!.querySelectorAll<HTMLButtonElement>("[data-reference-kind]"),
    ].map((b) => b.dataset.referenceKind);
    expect(slashKinds.length).toBeGreaterThan(0);
    expect(new Set(slashKinds)).toEqual(new Set(["action"]));

    // The `/` menu shows the merchant-facing name, never the tool id.
    const labels = [
      ...container!.querySelectorAll<HTMLElement>('[role="option"]'),
    ].map((li) => li.textContent ?? "");
    expect(labels.some((l) => l.includes("Issue a refund"))).toBe(true);
    expect(labels.some((l) => l.includes("refund.create"))).toBe(false);
  });

  it("smoothly scrolls one option at a time inside the menu", async () => {
    const editor = await mountField("Use @");
    caretToEnd(editor);

    await press(editor, "keyup", "@");
    const menu = container!.querySelector<HTMLElement>('[role="listbox"]')!;
    const rows = [
      ...container!.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    const rowHeight = 32;
    Object.defineProperty(menu, "clientHeight", {
      configurable: true,
      value: rowHeight * 3,
    });
    rows.forEach((row, index) => {
      Object.defineProperty(row, "offsetTop", {
        configurable: true,
        value: index * rowHeight,
      });
      Object.defineProperty(row, "offsetHeight", {
        configurable: true,
        value: rowHeight,
      });
    });

    const scrollTo = vi.fn((options?: ScrollToOptions) => {
      menu.scrollTop = Number(options?.top ?? 0);
    });
    Object.defineProperty(menu, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const pageJump = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    try {
      await press(editor, "keydown", "ArrowDown");
      await press(editor, "keydown", "ArrowDown");
      await press(editor, "keydown", "ArrowDown");

      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({
        top: rowHeight,
        behavior: "smooth",
      });
      expect(menu.scrollTop).toBe(rowHeight);
      expect(pageJump).not.toHaveBeenCalled();
    } finally {
      pageJump.mockRestore();
    }
  });

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
