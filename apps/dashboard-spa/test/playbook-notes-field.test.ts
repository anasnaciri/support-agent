import { describe, expect, it } from "vitest";
import { matchTokenAtCaret } from "../features/settings/PlaybookNotesField";

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
