import { describe, expect, it } from "vitest";
import { plainText } from "../src/plain-text.js";

describe("plainText", () => {
  it("leaves ordinary prose readable", () => {
    expect(plainText('Show "No matches yet." (2 of 3 met) - done!')).toBe(
      'Show "No matches yet." (2 of 3 met) - done!',
    );
  });

  it.each([
    ["\n", "a\nb"],
    ["\r\n", "a\r\nb"],
    ["\r", "a\rb"],
    ["blank lines and indentation", "a  \n\n    b"],
    ["U+2028", "a\u2028b"],
  ])("collapses line breaks to a single space (%s)", (_label, input) => {
    expect(plainText(input)).toBe("a b");
  });

  it.each([
    ["heading", "# Shipped", String.raw`\# Shipped`],
    ["quote", "> quoted", String.raw`\> quoted`],
    ["bullet", "- item", String.raw`\- item`],
    ["plus bullet", "+ item", String.raw`\+ item`],
    ["ordered list", "1. item", String.raw`1\. item`],
    ["ordered list with paren", "12) item", String.raw`12\) item`],
    ["setext underline", "===", String.raw`\===`],
  ])("escapes a leading block marker (%s)", (_label, input, expected) => {
    expect(plainText(input)).toBe(expected);
  });

  it("escapes inline Markdown and HTML anywhere in the text", () => {
    expect(plainText("a *b* _c_ `d` [e](f) ![g](h) <i> j|k ~~l~~ &amp; \\")).toBe(
      String.raw`a \*b\* \_c\_ \`d\` \[e\](f) !\[g\](h) \<i\> j\|k \~\~l\~\~ \&amp; \\`,
    );
  });

  it("leaves typical check output unchanged", () => {
    expect(plainText("unit tests: 142 passed")).toBe("unit tests: 142 passed");
  });
});
