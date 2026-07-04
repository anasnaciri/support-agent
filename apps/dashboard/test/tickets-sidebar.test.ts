import { describe, expect, it } from "vitest";

import {
  applyFreshPage,
  ticketIdFromPathname,
  ticketRowClasses,
  displayNameFromEmail,
  formatOrderRef,
  initialsFrom,
  isPriorityTicket,
  mergeDedupeById,
  parseStoredMode,
  shouldLoadMore,
  sidebarExcludeStatuses,
  sidebarRequestSignature,
  windowRange,
} from "../app/tickets/_components/tickets-sidebar-data.js";

describe("ticketIdFromPathname", () => {
  it.each([
    ["/tickets/abc", "abc"],
    ["/tickets/abc-123-def", "abc-123-def"],
    // nested ticket sub-routes still resolve to the ticket id
    ["/tickets/abc/anything", "abc"],
  ])("extracts the ticket id from %s", (pathname, expected) => {
    expect(ticketIdFromPathname(pathname)).toBe(expected);
  });

  it.each([["/tickets"], ["/tickets/"], ["/settings"], ["/"], ["/approvals/x"]])(
    "returns null for non-detail path %s",
    (pathname) => {
      expect(ticketIdFromPathname(pathname)).toBeNull();
    },
  );
});

describe("windowRange", () => {
  it("returns an empty window for zero rows", () => {
    expect(windowRange(0, 320, 64, 0, 2)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      totalHeight: 0,
    });
  });

  it("renders from the top with overscan clamped at 0", () => {
    // viewport shows 5 rows; overscan can't go below index 0.
    expect(windowRange(0, 320, 64, 100, 2)).toEqual({
      start: 0,
      end: 7,
      padTop: 0,
      totalHeight: 6400,
    });
  });

  it("windows correctly when scrolled into the middle", () => {
    expect(windowRange(640, 320, 64, 100, 2)).toEqual({
      start: 8,
      end: 17,
      padTop: 512,
      totalHeight: 6400,
    });
  });

  it("clamps the end to the row count near the bottom", () => {
    expect(windowRange(6080, 320, 64, 100, 2)).toEqual({
      start: 93,
      end: 100,
      padTop: 5952,
      totalHeight: 6400,
    });
  });

  it("never renders past a short list that fits the viewport", () => {
    expect(windowRange(0, 320, 64, 3, 2)).toEqual({
      start: 0,
      end: 3,
      padTop: 0,
      totalHeight: 192,
    });
  });
});

describe("shouldLoadMore", () => {
  const base = {
    scrollTop: 0,
    viewportHeight: 320,
    totalHeight: 6400,
    thresholdPx: 240,
    hasMore: true,
    loading: false,
  };

  it("is true once scrolled within the threshold of the bottom", () => {
    // bottom edge = scrollTop + viewport = 6160; remaining = 240 == threshold.
    expect(shouldLoadMore({ ...base, scrollTop: 5840 })).toBe(true);
  });

  it("is false while still far from the bottom", () => {
    expect(shouldLoadMore({ ...base, scrollTop: 1000 })).toBe(false);
  });

  it("is false when a fetch is already in flight", () => {
    expect(shouldLoadMore({ ...base, scrollTop: 6080, loading: true })).toBe(
      false,
    );
  });

  it("is false when there is nothing more to load", () => {
    expect(shouldLoadMore({ ...base, scrollTop: 6080, hasMore: false })).toBe(
      false,
    );
  });
});

describe("mergeDedupeById", () => {
  const row = (id: string) => ({ id, subject: id });

  it("appends rows that are not already present", () => {
    expect(mergeDedupeById([row("a"), row("b")], [row("c")])).toEqual([
      row("a"),
      row("b"),
      row("c"),
    ]);
  });

  it("drops incoming rows whose id is already loaded", () => {
    expect(mergeDedupeById([row("a"), row("b")], [row("b"), row("c")])).toEqual([
      row("a"),
      row("b"),
      row("c"),
    ]);
  });

  it("returns the existing rows unchanged for an empty page", () => {
    expect(mergeDedupeById([row("a")], [])).toEqual([row("a")]);
  });
});

// U8: after a takeover/resume the ticket-detail page revalidates but the
// client-state sidebar kept stale status badges. On pathname change the
// sidebar refetches page 1 and folds the fresh rows into what's loaded —
// updating in place (no reordering, no scroll jump, no pagination reset).
describe("applyFreshPage", () => {
  const row = (id: string, status = "in_progress") => ({ id, status });

  it("updates loaded rows in place from the fresh page", () => {
    expect(
      applyFreshPage(
        [row("a"), row("b"), row("c")],
        [row("b", "human_takeover")],
      ),
    ).toEqual([row("a"), row("b", "human_takeover"), row("c")]);
  });

  it("ignores fresh rows that are not currently loaded (no scroll jump)", () => {
    expect(applyFreshPage([row("a")], [row("z"), row("a", "resolved")])).toEqual(
      [row("a", "resolved")],
    );
  });

  it("returns the existing rows unchanged for an empty fresh page", () => {
    expect(applyFreshPage([row("a")], [])).toEqual([row("a")]);
  });
});

// The sidebar toggles between "All" and "Needs attention" (hide closed tickets).
// The mode drives a server-side excludeStatus filter, is folded into the
// stale-response guard so a mode switch resets to page 1, and is persisted.
describe("sidebarExcludeStatuses", () => {
  it("hides resolved and archived tickets in attention mode", () => {
    expect(sidebarExcludeStatuses("attention")).toEqual(["resolved", "archived"]);
  });

  it("hides nothing in all mode", () => {
    expect(sidebarExcludeStatuses("all")).toEqual([]);
  });
});

describe("sidebarRequestSignature", () => {
  it("differs by mode for the same query so a switch supersedes in-flight fetches", () => {
    expect(sidebarRequestSignature("all", "ann")).not.toBe(
      sidebarRequestSignature("attention", "ann"),
    );
  });

  it("differs by query within a mode", () => {
    expect(sidebarRequestSignature("all", "ann")).not.toBe(
      sidebarRequestSignature("all", "bob"),
    );
  });

  it("is stable for the same mode + query", () => {
    expect(sidebarRequestSignature("attention", "x")).toBe(
      sidebarRequestSignature("attention", "x"),
    );
  });
});

describe("parseStoredMode", () => {
  it("round-trips a stored mode", () => {
    expect(parseStoredMode("attention")).toBe("attention");
    expect(parseStoredMode("all")).toBe("all");
  });

  it("defaults to all for anything unrecognized", () => {
    expect(parseStoredMode(null)).toBe("all");
    expect(parseStoredMode("")).toBe("all");
    expect(parseStoredMode("garbage")).toBe("all");
  });
});

describe("initialsFrom", () => {
  it("takes up to two initials from a name or email", () => {
    expect(initialsFrom("Jane Lin")).toBe("JL");
    expect(initialsFrom("jane.lin@shop.com")).toBe("JL");
    expect(initialsFrom("sam@acme.co")).toBe("SA");
    expect(initialsFrom("madonna")).toBe("M");
  });
  it("falls back to '?' for empty input", () => {
    expect(initialsFrom(null)).toBe("?");
    expect(initialsFrom("")).toBe("?");
    expect(initialsFrom("   ")).toBe("?");
  });
});

describe("displayNameFromEmail", () => {
  it("title-cases the local part, split on separators", () => {
    expect(displayNameFromEmail("jane.lin@shop.com")).toBe("Jane Lin");
    expect(displayNameFromEmail("sam_okoro@x.io")).toBe("Sam Okoro");
    expect(displayNameFromEmail("orders@shop.com")).toBe("Orders");
  });
  it("is null without an email", () => {
    expect(displayNameFromEmail(null)).toBeNull();
    expect(displayNameFromEmail(undefined)).toBeNull();
  });
});

describe("isPriorityTicket", () => {
  it("is true only for a non-normal priority", () => {
    expect(isPriorityTicket("high")).toBe(true);
    expect(isPriorityTicket("urgent")).toBe(true);
    expect(isPriorityTicket("normal")).toBe(false);
    expect(isPriorityTicket(null)).toBe(false);
    expect(isPriorityTicket(undefined)).toBe(false);
    expect(isPriorityTicket("")).toBe(false);
  });
});

describe("formatOrderRef", () => {
  it("keeps a human order name as-is", () => {
    expect(formatOrderRef("#1001")).toBe("#1001");
  });
  it("collapses a GID or bare numeric id to #<n>", () => {
    expect(formatOrderRef("gid://shopify/Order/1234567")).toBe("#1234567");
    expect(formatOrderRef("1044")).toBe("#1044");
  });
  it("is null when there's no order", () => {
    expect(formatOrderRef(null)).toBeNull();
    expect(formatOrderRef("")).toBeNull();
    expect(formatOrderRef("   ")).toBeNull();
  });
});

describe("ticketRowClasses", () => {
  it("keeps the elevated, medium-weight look for the active row (any status)", () => {
    const a = ticketRowClasses({ status: "resolved", active: true });
    expect(a.subject).toContain("font-medium");
    expect(a.container).toContain("bg-card");
    // Selected state is a left accent bar, not a shadow/ring.
    expect(a.container).toContain("border-l-primary");
    expect(a.container).not.toContain("shadow");
    // active wins over the resolved de-emphasis
    expect(a.container).not.toContain("opacity-");
    expect(a.subject).not.toContain("font-light");
  });

  it("bumps inactive non-resolved rows: semibold, no fill", () => {
    const r = ticketRowClasses({ status: "in_progress", active: false });
    expect(r.subject).toContain("font-semibold");
    // No background fill — flush rows split by dividers; weight carries it.
    expect(r.container).not.toContain("bg-muted");
    expect(r.container).not.toContain("opacity-");
  });

  it("recedes inactive resolved rows: thinner, muted, lower opacity", () => {
    const r = ticketRowClasses({ status: "resolved", active: false });
    expect(r.subject).toContain("font-light");
    expect(r.subject).toContain("text-muted-foreground");
    expect(r.container).toContain("opacity-60");
  });

  it("recedes inactive archived rows like other closed tickets", () => {
    const r = ticketRowClasses({ status: "archived", active: false });
    expect(r.subject).toContain("font-light");
    expect(r.subject).toContain("text-muted-foreground");
    expect(r.container).toContain("opacity-60");
  });
});
