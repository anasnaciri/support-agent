import { describe, expect, it, vi } from "vitest";

import { handleSendShortcut, isMacOS } from "../lib/send-shortcut";

describe("isMacOS", () => {
  it("recognizes a macOS browser platform", () => {
    expect(isMacOS("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"))
      .toBe(true);
  });
});

describe("handleSendShortcut", () => {
  it("sends with Command+Enter on macOS", () => {
    const preventDefault = vi.fn();
    const send = vi.fn();

    const handled = handleSendShortcut(
      {
        key: "Enter",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault,
      },
      { isMacOS: true, disabled: false, send },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends with Control+Enter outside macOS", () => {
    const preventDefault = vi.fn();
    const send = vi.fn();

    const handled = handleSendShortcut(
      {
        key: "Enter",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        preventDefault,
      },
      { isMacOS: false, disabled: false, send },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps Enter and the other platform's modifier available for editing", () => {
    const preventDefault = vi.fn();
    const send = vi.fn();
    const event = {
      key: "Enter",
      altKey: false,
      shiftKey: false,
      preventDefault,
    };

    expect(
      handleSendShortcut(
        { ...event, metaKey: false, ctrlKey: false },
        { isMacOS: true, disabled: false, send },
      ),
    ).toBe(false);
    expect(
      handleSendShortcut(
        { ...event, metaKey: false, ctrlKey: true },
        { isMacOS: true, disabled: false, send },
      ),
    ).toBe(false);
    expect(
      handleSendShortcut(
        { ...event, metaKey: true, ctrlKey: false },
        { isMacOS: false, disabled: false, send },
      ),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send while the send action is disabled", () => {
    const preventDefault = vi.fn();
    const send = vi.fn();

    expect(
      handleSendShortcut(
        {
          key: "Enter",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          preventDefault,
        },
        { isMacOS: true, disabled: true, send },
      ),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
