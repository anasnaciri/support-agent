import { describe, expect, it } from "vitest";
import type { ConnectorConnectionView } from "@support-agent/dashboard-contracts";

import { hasMailbox, setupGaps } from "../lib/setup-readiness";

const conn = (
  provider: string,
  status: ConnectorConnectionView["status"] = "active",
): ConnectorConnectionView =>
  ({ provider, status }) as ConnectorConnectionView;

describe("hasMailbox", () => {
  it("counts any active customer-mail connector", () => {
    expect(hasMailbox([conn("gmail")])).toBe(true);
    expect(hasMailbox([conn("outlook")])).toBe(true);
    expect(hasMailbox([conn("imap")])).toBe(true);
  });

  it("ignores a revoked mailbox", () => {
    expect(hasMailbox([conn("gmail", "revoked")])).toBe(false);
  });

  it("does not mistake the store for an inbox", () => {
    expect(hasMailbox([conn("shopify")])).toBe(false);
  });
});

describe("setupGaps", () => {
  const ready = { llmConnected: true, mailboxConnected: true, steps: null };

  it("reports nothing for a fully configured workspace", () => {
    expect(setupGaps(ready)).toEqual([]);
  });

  it("reports a missing AI provider as an error", () => {
    const gaps = setupGaps({ ...ready, llmConnected: false });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "llm", severity: "error" });
  });

  it("reports a missing inbox as a warning", () => {
    const gaps = setupGaps({ ...ready, mailboxConnected: false });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "mailbox", severity: "warning" });
  });

  it("reports both, worst first", () => {
    const gaps = setupGaps({
      llmConnected: false,
      mailboxConnected: false,
      steps: null,
    });
    expect(gaps.map((g) => g.kind)).toEqual(["llm", "mailbox"]);
  });

  it("stays quiet inside the wizard until the merchant reaches the step", () => {
    // Warning someone that they're missing an API key on the step BEFORE we ask
    // for one is noise, and trains them to ignore the banner that matters.
    expect(
      setupGaps({
        llmConnected: false,
        mailboxConnected: false,
        steps: { store: "done" },
      }),
    ).toEqual([]);
  });

  it("warns once the merchant has passed the step", () => {
    const gaps = setupGaps({
      llmConnected: false,
      mailboxConnected: false,
      steps: { llm: "skipped", email: "skipped" },
    });
    expect(gaps.map((g) => g.kind)).toEqual(["llm", "mailbox"]);
  });

  it("keeps warning about a step marked done that did not actually connect", () => {
    // "done" is the merchant's claim; the connection list is the truth.
    const gaps = setupGaps({
      llmConnected: false,
      mailboxConnected: true,
      steps: { llm: "done" },
    });
    expect(gaps.map((g) => g.kind)).toEqual(["llm"]);
  });
});
