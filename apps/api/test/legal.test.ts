import { describe, expect, it } from "vitest";

import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
} from "@support-agent/services";

import { renderDataProcessingNoticeHtml } from "../src/legal.js";

describe("renderDataProcessingNoticeHtml", () => {
  const html = renderDataProcessingNoticeHtml();

  it("renders a flat, light page (no auto light/dark switch)", () => {
    // Flat = a single solid palette, not the OS-driven `color-scheme: light dark`.
    expect(html).not.toContain("light dark");
    expect(html).toContain("background: #ffffff");
  });

  it("still renders the current notice + DPA versions and headings", () => {
    expect(html).toContain(DATA_PROCESSING_NOTICE_VERSION);
    expect(html).toContain(DPA_VERSION);
    expect(html).toContain("Data Processing Notice");
    expect(html).toContain("Data Processing Addendum");
  });
});
