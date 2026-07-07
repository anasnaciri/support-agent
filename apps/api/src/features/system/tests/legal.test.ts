import { describe, expect, it } from "vitest";

import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
} from "@support-agent/services";

import { renderDataProcessingNoticeHtml } from "../legal.js";

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

  it("names every live subprocessor entity with its purpose", () => {
    // One row per legal entity — product names (R2, Gmail) only describe scope.
    expect(html).toContain("Microsoft");
    expect(html).toContain("Telegram");
    expect(html).toContain("Cloudflare");
    expect(html).not.toContain("Cloudflare R2");
    // Merchant-connected IMAP/SMTP servers are covered alongside Gmail/Outlook.
    expect(html).toContain("IMAP/SMTP");
  });

  it("discloses supplier sharing as merchant-directed, not subprocessing", () => {
    expect(html).toContain("supplier");
    expect(html).toContain("merchant's instructions");
  });

  it("was re-versioned for the subprocessor-list change", () => {
    // Microsoft/Telegram landed before 2026-07-04; the corrected list must
    // carry a version bump so existing tenants re-accept.
    expect(DATA_PROCESSING_NOTICE_VERSION >= "2026-07-07").toBe(true);
  });
});
