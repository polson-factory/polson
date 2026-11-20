/**
 * Render untrusted record text as inert Markdown.
 *
 * Every free-text field from a night record goes through `plainText` before it
 * is placed in the report, so record text can never add a heading, list item,
 * quote, link, image, code span, HTML, or emphasis of its own.
 *
 * 1. Line breaks (and the spaces around them) collapse to a single space, so the
 *    text stays on the line the report put it on. Block structure in Markdown
 *    needs a new line, so this removes most of the risk.
 * 2. Characters that can start inline structure anywhere in a line are
 *    backslash-escaped.
 * 3. Markers that only mean something at the start of a line (`#`, `>`, `-`,
 *    `+`, `=`, `1.`, `1)`) are escaped when the text begins with them, because
 *    some fields do start a line or a list item.
 *
 * Ordinary prose punctuation (`.`, `,`, `-` mid-sentence, `!`, `(`, `)`) is left
 * alone so the report stays readable as plain text in a terminal.
 */

const LINE_BREAKS = /\s*[\r\n\v\f\u0085\u2028\u2029]\s*/g;
const INLINE_SPECIAL = /[\\`*_[\]<>|~&]/g;
const LEADING_MARKER = /^[#>+=-]/;
const LEADING_ORDERED_MARKER = /^(\d+)([.)])/;

export function plainText(value: string): string {
  return value
    .replace(LINE_BREAKS, " ")
    .trim()
    .replace(INLINE_SPECIAL, "\\$&")
    .replace(LEADING_MARKER, "\\$&")
    .replace(LEADING_ORDERED_MARKER, "$1\\$2");
}
