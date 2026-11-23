// Tests .github/polson/qodo-open-findings.sh on real Qodo review comments saved
// from this repo's PRs (fixtures/qodo/), so its awk counting path runs on the
// CI runner's awk. Issue: https://github.com/shrooms08/polson/issues/23
// The script reads a comment body on stdin and prints the number of open High or
// Medium findings, or "unknown" if the comment cannot be read with confidence.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../.github/polson/qodo-open-findings.sh");
const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "../fixtures/qodo", name), "utf8");

function run(body: string): string {
  const r = spawnSync("bash", [SCRIPT], { input: body, encoding: "utf8" });
  // Fail loudly if bash or awk cannot run: that must not look like "unknown".
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe("qodo-open-findings.sh on real Qodo comments", () => {
  it("counts the open Medium finding (PR #20: 1 open Medium, 1 resolved)", () => {
    expect(run(fixture("pr20-open-medium.md"))).toBe("1");
  });

  it("reports 0 when every finding is resolved (PR #19)", () => {
    expect(run(fixture("pr19-all-resolved.md"))).toBe("0");
  });

  it('reports 0 for "no issues found" (PR #11)', () => {
    expect(run(fixture("pr11-no-issues.md"))).toBe("0");
  });

  // PR #24's own review quotes "Resolved findings", "no issues found" and a
  // `<summary>  1.` line inside its findings. The quoted text must not be read as
  // structure. Its second finding is labelled by Qodo's "View medium (1)" header.
  it("counts both open Medium findings, ignoring quoted markup (PR #24)", () => {
    expect(run(fixture("pr24-open-two-medium.md"))).toBe("2");
  });

  // PR #40 lists three Low findings under one "View low (3)" header and one Low
  // badge (issue #41). The header labels all three.
  it('reports 0 for three Low findings in one "View low (3)" group (PR #40)', () => {
    expect(run(fixture("pr40-three-low.md"))).toBe("0");
  });
});

// Issue #41: a "View <severity> (N)" header labels the next N findings in its
// group. A group with fewer or more findings than its N is unknown (rule 6).
describe("qodo-open-findings.sh: severity groups", () => {
  const low = fixture("pr40-three-low.md");
  const LOW_HEADER = "<details><summary><ins><strong>View low (3)</strong></ins></summary><br/>";
  const MEDIUM_BADGE =
    '<img src="https://img.shields.io/badge/Medium-634FD1?style=flat-square" height="20px" alt="Remediation recommended">';

  /** One finding block, in the shape PR #40's comment lists them. */
  const finding = (n: number) =>
    `<details>\n<summary>  ${n}.  Medium finding ${n} <code>🐞 Bug</code></summary>\n\n<br/>\n\n>Quoted description\n\n<hr/>\n</details>\n\n\n`;

  /** PR #40 with a "View medium (<header>)" group of `findings` findings before its Low group. */
  function withMediumGroup(header: number, findings: number): string {
    expect(low).toContain(LOW_HEADER);
    expect(low).toContain("<code>🐞 Bugs (3)</code>");
    const group =
      `<details><summary><ins><strong>View medium (${header})</strong></ins></summary><br/>\n${MEDIUM_BADGE}\n\n` +
      Array.from({ length: findings }, (_, i) => finding(i + 1)).join("") +
      "</details>\n\n";
    return low.replace(LOW_HEADER, group + LOW_HEADER).replace("Bugs (3)", `Bugs (${3 + findings})`);
  }

  it("a mixed review, 2 Medium then 3 Low, each group under its header: 2", () => {
    expect(run(withMediumGroup(2, 2))).toBe("2");
  });

  it.each([
    { name: '"View low (4)" over three findings', body: () => low.replace("View low (3)", "View low (4)") },
    { name: '"View low (2)" over three findings', body: () => low.replace("View low (3)", "View low (2)") },
    { name: '"View medium (3)" over two findings, then the Low group', body: () => withMediumGroup(3, 2) },
    { name: '"View medium (1)" over two findings, then the Low group', body: () => withMediumGroup(1, 2) },
    { name: 'a "View low (0)" header', body: () => low.replace("View low (3)", "View low (0)") },
    { name: "a group header without a count", body: () => low.replace("View low (3)", "View low") },
  ])("count mismatch, $name: unknown", ({ body }) => {
    expect(run(body())).toBe("unknown");
  });

  it("a group badge that disagrees with its header: unknown", () => {
    const badge = low.match(/^<img src="https:\/\/img\.shields\.io\/badge\/Low-[^\n]*$/m)?.[0];
    expect(badge).toBeDefined();
    expect(run(low.replace(badge ?? "", MEDIUM_BADGE))).toBe("unknown");
  });
});

describe("qodo-open-findings.sh fails closed", () => {
  const open = fixture("pr20-open-medium.md");

  it("reports unknown for a comment truncated before the findings", () => {
    const cut = open.slice(0, open.indexOf("<details>\n<summary>  1.  Agent"));
    expect(cut.length).toBeGreaterThan(0);
    expect(run(cut)).toBe("unknown");
  });

  it("reports unknown when the count badge says more findings than are listed", () => {
    expect(run(open.replace("Requirement gaps (1)", "Requirement gaps (2)"))).toBe("unknown");
  });

  // A comment cut short can still have count badges that match the findings it
  // lists. Only Qodo's footer shows the comment is complete.
  it('reports unknown for PR #20 cut before "Resolved findings"', () => {
    expect(run(open.slice(0, open.indexOf("<details><summary><strong>Resolved findings")))).toBe("unknown");
  });

  it("reports unknown for PR #20 cut three lines into finding 1", () => {
    const lines = open.split("\n");
    const summary = lines.findIndex((line) => line.startsWith("<summary>  1.  Agent"));
    expect(summary).toBeGreaterThan(0);
    expect(run(lines.slice(0, summary + 4).join("\n"))).toBe("unknown");
  });

  it('reports unknown for PR #11 cut before "no issues found"', () => {
    const body = fixture("pr11-no-issues.md");
    expect(run(body.slice(0, body.indexOf("<h3>Great, no issues found!")))).toBe("unknown");
  });

  // Qodo on PR #24 ("Truncated comment reports a count"): a comment cut anywhere
  // before its footer must never print a count, whatever the badges say.
  it.each(["pr11-no-issues.md", "pr19-all-resolved.md", "pr20-open-medium.md", "pr24-open-two-medium.md", "pr40-three-low.md"])(
    "reports unknown for %s cut after any line before the footer",
    (name) => {
      const lines = fixture(name).split("\n");
      const footer = lines.findIndex((line) => line.startsWith('<a href="https://www.qodo.ai"><img'));
      expect(footer).toBeGreaterThan(0);
      const counted = [];
      for (let keep = 1; keep <= footer; keep++) {
        if (run(lines.slice(0, keep).join("\n")) !== "unknown") counted.push(keep);
      }
      expect(counted, "line counts that still printed a number").toEqual([]);
    },
    30_000,
  );

  it("reports unknown for a resolved-only comment cut before the resolved section", () => {
    const body = fixture("pr19-all-resolved.md");
    expect(run(body.slice(0, body.indexOf("Resolved findings")))).toBe("unknown");
  });

  it("reports unknown for a finding without a severity badge", () => {
    expect(run(open.replace(/<img src="https:\/\/img\.shields\.io[^>]*>/, ""))).toBe("unknown");
  });

  it("reports unknown for empty input", () => {
    expect(run("")).toBe("unknown");
  });

  it("reports unknown for unreadable text that is not a Qodo review", () => {
    expect(run("\u0000\u0001\u0002 not a review")).toBe("unknown");
  });

  it("reports unknown for a comment that is not Qodo's review", () => {
    expect(run(open.replace("Code Review by Qodo", "Something else"))).toBe("unknown");
  });
});

// Each open finding needs its own severity label (a severity badge or Qodo's
// "View <severity> (N)" header) between the previous finding and itself. A finding
// must never take the severity of the one before it (Qodo on PR #24, rule 6).
describe("qodo-open-findings.sh: an unlabelled finding makes the review unknown", () => {
  const open = fixture("pr20-open-medium.md");
  const LOW_BADGE =
    '<img src="https://img.shields.io/badge/Low-634FD1?style=flat-square" height="20px" alt="Informational">';
  const MEDIUM_BADGE =
    '<img src="https://img.shields.io/badge/Medium-634FD1?style=flat-square" height="20px" alt="Remediation recommended">';

  /** PR #20 with a second open finding after the first, preceded by `label`. */
  function withSecondFinding(body: string, label: string): string {
    const second = `${label}\n<details>\n<summary>  2.  Second finding <code>📎 Requirement gap</code></summary>\n</details>\n\n`;
    const at = body.indexOf("<details><summary><strong>Resolved findings");
    expect(at).toBeGreaterThan(0);
    return (body.slice(0, at) + second + body.slice(at)).replace("Requirement gaps (1)", "Requirement gaps (2)");
  }

  it("after a Medium finding", () => {
    expect(run(withSecondFinding(open, ""))).toBe("unknown");
  });

  it("after a Low finding: never counted as Low", () => {
    expect(run(withSecondFinding(open.replace(MEDIUM_BADGE, LOW_BADGE), ""))).toBe("unknown");
  });

  it("under a severity badge the script does not know (#22)", () => {
    const critical = MEDIUM_BADGE.replace("Medium-", "Critical-");
    expect(run(withSecondFinding(open, critical))).toBe("unknown");
  });

  // Control: the same second finding with its own label is counted, so the cases
  // above report unknown because of the missing label, not the edit.
  it('control: counts it when Qodo\'s "View medium (1)" header labels it', () => {
    const view = "<details><summary><ins><strong>View medium (1)</strong></ins></summary><br/>";
    expect(run(withSecondFinding(open, view))).toBe("2");
  });
});
