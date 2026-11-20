import type { NightRecord, Outcome } from "./night-record.js";
import { plainText } from "./plain-text.js";

/**
 * Render one night's record as a plain-language Markdown report.
 *
 * Pure and deterministic: the output depends only on the record, so the same
 * record always produces the same text. No clocks, no randomness.
 *
 * Every free-text field from the record goes through `plainText`, so record
 * text cannot add headings, list items, links or other Markdown structure.
 */

const VERDICT_LINE: Record<Outcome, string> = {
  shipped: "**Shipped.** The change was approved in review and passed every check.",
  blocked: "**Blocked.** Polson stopped and nothing shipped.",
  escalated: "**Needs you.** Polson stopped and has a question only you can answer.",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function renderMorningReport(record: NightRecord): string {
  const lines: string[] = [];
  const section = (heading: string, ...body: string[]) => lines.push(heading, "", ...body, "");

  section(`# Morning report: ${record.date}`, VERDICT_LINE[record.outcome]);

  // What needs the human comes first, before the details of the work.
  if (record.outcome === "escalated") {
    section(
      "## Needs your answer",
      `**Question:** ${plainText(record.questionForHuman)}`,
      "",
      `**Why Polson stopped:** ${plainText(record.reason)}`,
    );
  } else if (record.outcome === "blocked") {
    section("## Why it was blocked", plainText(record.reason));
  }

  section(
    "## Task",
    `**${plainText(record.task.title)}** (${plainText(record.task.id)})`,
    "",
    "Acceptance criteria:",
    ...record.task.acceptanceCriteria.map((criterion) => `- ${plainText(criterion)}`),
  );

  if (record.review) {
    const verdict = record.review.verdict === "approved" ? "Approved" : "Changes requested";
    section(
      "## Review",
      `${verdict} by ${plainText(record.review.reviewer)} (${plural(record.review.findings, "finding")}).`,
    );
  } else {
    section("## Review", "No review was recorded.");
  }

  if (record.checks.length > 0) {
    section(
      "## Checks",
      ...record.checks.map((check) => {
        const detail = check.detail ? `: ${plainText(check.detail)}` : "";
        return `- ${check.status === "pass" ? "PASS" : "FAIL"} ${plainText(check.name)}${detail}`;
      }),
    );
  } else {
    section("## Checks", "No checks were recorded.");
  }

  if (record.pullRequest) {
    section(
      "## Pull request",
      // The schema only admits normalized http(s) URLs; the angle brackets keep
      // characters like ")" from ending the link early.
      `[#${record.pullRequest.number}](<${record.pullRequest.url}>)`,
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}
