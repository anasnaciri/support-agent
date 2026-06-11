import { describe, expect, it } from "vitest";

import {
  applyFreshPage,
  caseIdFromPathname,
  mergeDedupeById,
  shouldLoadMore,
  windowRange,
} from "../app/cases/_components/cases-sidebar-data.js";

describe("caseIdFromPathname", () => {
  it.each([
    ["/cases/abc", "abc"],
    ["/cases/abc-123-def", "abc-123-def"],
    // nested case sub-routes still resolve to the case id
    ["/cases/abc/anything", "abc"],
  ])("extracts the case id from %s", (pathname, expected) => {
    expect(caseIdFromPathname(pathname)).toBe(expected);
  });

  it.each([["/cases"], ["/cases/"], ["/settings"], ["/"], ["/approvals/x"]])(
    "returns null for non-detail path %s",
    (pathname) => {
      expect(caseIdFromPathname(pathname)).toBeNull();
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

// U8: after a takeover/resume the case-detail page revalidates but the
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
