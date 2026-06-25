import { describe, expect, it } from "vitest";

import { resolveFeedback, type FeedbackRule } from "../lib/toast-feedback";

// `resolveFeedback` is the shared matcher behind the post-action toasts: given
// the page's current URL search params and a declarative rule set, it decides
// which toasts to fire and which params to strip from the URL so a refresh
// doesn't replay them. The matching mirrors the old inline banner conditionals
// (`saved === "1"`, `error === "bad_currency"`, plus a catch-all fallback).

const SAVED: FeedbackRule = {
  param: "saved",
  kind: "success",
  message: "Saved.",
};

describe("resolveFeedback", () => {
  it("fires a flag rule when the param equals \"1\" and consumes it", () => {
    const { toasts, consume } = resolveFeedback({ saved: "1" }, [SAVED]);
    expect(toasts).toEqual([{ kind: "success", message: "Saved." }]);
    expect(consume).toEqual(["saved"]);
  });

  it("ignores a flag param whose value is not \"1\"", () => {
    const { toasts, consume } = resolveFeedback({ saved: "0" }, [SAVED]);
    expect(toasts).toEqual([]);
    expect(consume).toEqual([]);
  });

  it("ignores a missing param", () => {
    const { toasts, consume } = resolveFeedback({}, [SAVED]);
    expect(toasts).toEqual([]);
    expect(consume).toEqual([]);
  });

  it("matches an exact value rule", () => {
    const rules: FeedbackRule[] = [
      { param: "error", match: "bad_currency", kind: "warning", message: "Bad currency." },
      { param: "error", match: "bad_amount", kind: "warning", message: "Bad amount." },
    ];
    const { toasts, consume } = resolveFeedback({ error: "bad_amount" }, rules);
    expect(toasts).toEqual([{ kind: "warning", message: "Bad amount." }]);
    expect(consume).toEqual(["error"]);
  });

  it("falls back to a \"*\" rule when no exact value matches", () => {
    const rules: FeedbackRule[] = [
      { param: "error", match: "bad_currency", kind: "warning", message: "Bad currency." },
      { param: "error", match: "*", kind: "warning", message: "Something went wrong." },
    ];
    const { toasts, consume } = resolveFeedback({ error: "weird_code" }, rules);
    expect(toasts).toEqual([
      { kind: "warning", message: "Something went wrong." },
    ]);
    expect(consume).toEqual(["error"]);
  });

  it("prefers the exact rule over the \"*\" fallback for the same param", () => {
    const rules: FeedbackRule[] = [
      { param: "error", match: "bad_currency", kind: "warning", message: "Bad currency." },
      { param: "error", match: "*", kind: "warning", message: "Something went wrong." },
    ];
    const { toasts, consume } = resolveFeedback({ error: "bad_currency" }, rules);
    expect(toasts).toEqual([{ kind: "warning", message: "Bad currency." }]);
    expect(consume).toEqual(["error"]);
  });

  it("does not consume an unmatched param with no fallback", () => {
    const rules: FeedbackRule[] = [
      { param: "error", match: "bad_currency", kind: "warning", message: "Bad currency." },
    ];
    const { toasts, consume } = resolveFeedback({ error: "weird_code" }, rules);
    expect(toasts).toEqual([]);
    expect(consume).toEqual([]);
  });

  it("fires multiple toasts across different params, preserving rule order", () => {
    const rules: FeedbackRule[] = [
      SAVED,
      { param: "error", match: "*", kind: "warning", message: "Oops." },
    ];
    const { toasts, consume } = resolveFeedback({ saved: "1", error: "x" }, rules);
    expect(toasts).toEqual([
      { kind: "success", message: "Saved." },
      { kind: "warning", message: "Oops." },
    ]);
    expect(consume).toEqual(["saved", "error"]);
  });

  it("reads the first entry of an array-valued param", () => {
    const { toasts } = resolveFeedback({ saved: ["1", "ignored"] }, [SAVED]);
    expect(toasts).toEqual([{ kind: "success", message: "Saved." }]);
  });

  it("accepts a URLSearchParams source", () => {
    const params = new URLSearchParams("saved=1");
    const { toasts, consume } = resolveFeedback(params, [SAVED]);
    expect(toasts).toEqual([{ kind: "success", message: "Saved." }]);
    expect(consume).toEqual(["saved"]);
  });

  it("passes through description and action", () => {
    const rules: FeedbackRule[] = [
      {
        param: "onboarded",
        kind: "success",
        message: "Workspace ready",
        description: "Connect a store to start.",
        action: { label: "Open Integrations", href: "/settings/integrations" },
      },
    ];
    const { toasts } = resolveFeedback({ onboarded: "1" }, rules);
    expect(toasts).toEqual([
      {
        kind: "success",
        message: "Workspace ready",
        description: "Connect a store to start.",
        action: { label: "Open Integrations", href: "/settings/integrations" },
      },
    ]);
  });

  it("supports a custom exact match value (not just \"1\")", () => {
    const rules: FeedbackRule[] = [
      { param: "model", match: "updated", kind: "success", message: "Model updated." },
      { param: "model", match: "reset", kind: "success", message: "Model reset." },
    ];
    expect(resolveFeedback({ model: "reset" }, rules).toasts).toEqual([
      { kind: "success", message: "Model reset." },
    ]);
  });
});
