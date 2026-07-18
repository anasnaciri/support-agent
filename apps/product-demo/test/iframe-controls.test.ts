import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import {
  findCustomerComposer,
  setControlledValue,
  streamedText,
} from "../iframe-controls.js";

describe("product-demo iframe controls", () => {
  it("targets the approval composer instead of the first textarea on the page", () => {
    const dom = new JSDOM(`
      <textarea placeholder="Some other field"></textarea>
      <textarea placeholder="Edit the drafted reply before approving…"></textarea>
    `);

    expect(findCustomerComposer(dom.window.document)?.placeholder).toContain(
      "drafted reply",
    );
  });

  it("streams partial text and dispatches input in the iframe's own realm", () => {
    const dom = new JSDOM("<textarea></textarea>");
    const textarea = dom.window.document.querySelector("textarea")!;
    const onInput = vi.fn((event: Event) => {
      expect(event).toBeInstanceOf(dom.window.InputEvent);
    });
    textarea.addEventListener("input", onInput);

    expect(streamedText("Agent response", 0.5)).toBe("Agent r");
    setControlledValue(textarea, streamedText("Agent response", 0.5));

    expect(textarea.value).toBe("Agent r");
    expect(onInput).toHaveBeenCalledOnce();
  });
});
