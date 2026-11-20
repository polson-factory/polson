import type { NightRecord, Outcome } from "./night-record.js";

/**
 * Render one night's record as a plain-language Markdown report.
 *
 * Pure and deterministic: the output depends only on the record, so the same
 * record always produces the same text. No clocks, no randomness.
 */

const VERDICT_LINE: Record<Outcome, string> = {
  shipped: "**Shipped.** The change passed review and every check that ran.",
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
      `**Question:** ${record.questionForHuman}`,
      "",
      `**Why Polson stopped:** ${record.reason}`,
    );
  } else if (record.outcome === "blocked") {
    section("## Why it was blocked", record.reason);
  }

  section(
    "## Task",
    `**${record.task.title}** (${record.task.id})`,
    "",
    "Acceptance criteria:",
    ...record.task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  );

  if (record.review) {
    const verdict = record.review.verdict === "approved" ? "Approved" : "Changes requested";
    section(
      "## Review",
      `${verdict} by ${record.review.reviewer} (${plural(record.review.findings, "finding")}).`,
    );
  } else {
    section("## Review", "No review was recorded.");
  }

  if (record.checks.length > 0) {
    section(
      "## Checks",
      ...record.checks.map((check) => {
        const detail = check.detail ? `: ${check.detail}` : "";
        return `- ${check.status === "pass" ? "PASS" : "FAIL"} ${check.name}${detail}`;
      }),
    );
  } else {
    section("## Checks", "No checks were recorded.");
  }

  if (record.pullRequest) {
    section(
      "## Pull request",
      `[#${record.pullRequest.number}](${record.pullRequest.url})`,
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}
