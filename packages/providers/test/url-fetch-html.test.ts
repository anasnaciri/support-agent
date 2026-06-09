import { describe, expect, it } from "vitest";
import { extractTitle, htmlToText } from "../src/url-fetch-html.js";

describe("extractTitle", () => {
  it("extracts and decodes the <title>", () => {
    expect(extractTitle("<html><title>Hello &amp; Co</title></html>")).toBe(
      "Hello & Co",
    );
  });
  it("returns null when there's no title", () => {
    expect(extractTitle("<html><body>x</body></html>")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("drops script and style content entirely", () => {
    const html =
      "<html><head><style>.a{color:red}</style></head><body><script>steal()</script><p>Visible text</p></body></html>";
    const out = htmlToText(html);
    expect(out).toContain("Visible text");
    expect(out).not.toContain("steal");
    expect(out).not.toContain("color:red");
  });

  it("decodes common entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s</p>")).toBe(
      'Tom & Jerry <3 "hi" it\'s',
    );
  });

  it("turns block elements into line breaks and collapses whitespace", () => {
    const html =
      "<div>Line one</div><p>Line two</p><ul><li>a</li><li>b</li></ul>";
    const out = htmlToText(html);
    expect(out.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "Line one",
      "Line two",
      "a",
      "b",
    ]);
  });

  it("returns an empty string for markup with no readable text", () => {
    expect(htmlToText("<html><head></head><body></body></html>")).toBe("");
    expect(htmlToText("   <br/> <hr> ")).toBe("");
  });
});
